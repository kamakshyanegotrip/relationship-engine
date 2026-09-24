# Relationship Engine

Web app for the NegoTrip Professional Relationship Engine: a LinkedIn-assisted connection, follow-up and nurturing CRM that runs on n8n.

**Live:** https://kamakshyanegotrip.github.io/relationship-engine/

## What it does

- **Today**: the day's LinkedIn connection queue with three AI-drafted notes per person, requests due an acceptance check, and follow-up drafts ready to send.
- **Pipeline**: contacts per stage, 21-day activity, per-campaign reach and connect rates, recent activity.
- **Contacts**: search and filter everyone; open a person to see their history, log a reply for AI classification, edit details, or mark do-not-contact.
- **Add people**: add one person, or paste CSV / tab-separated rows (up to 200) for AI qualification.

LinkedIn is never automated. You send every request and message yourself; the app records what you did and schedules the next touchpoint. Email follow-ups only create Gmail drafts.

## How it connects

Static HTML, CSS and JavaScript with no build step. It talks to the PRE-05 Web App API workflow on n8n, which reads the PRE Contacts, PRE Campaigns and PRE Interactions data tables and forwards actions to PRE-01 (intake), PRE-02 (daily queue), PRE-03 (follow-ups) and PRE-04 (actions and reply logging).

Every request carries an access key that you enter once under Settings; it is stored only in your browser. Without a key the app shows fictional demo data. No contact data is stored in this repository.
