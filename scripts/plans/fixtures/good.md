# Example — PLAN
Status: DRAFT · Contract revision: r1 · Execution tracking: TRACKING.md
## Gate
### 1. Flows
| Flow | Who | Steps | Features | Calls per operation |
|---|---|---|---|---|
| F1 deploy | owner | press Deploy → running | logs, rollback | 1 admit + N services + 1 settle |
### 2. Mechanism ledger
| Mechanism | Owner (one place) | User-visible harm without it | Reachable how | Reference that does it OR Happier-specific requirement | Cost per operation |
|---|---|---|---|---|---|
| M1 admission check of current authority | server deploy admission | another Team member deploys to my Machine | named cross-person threat | Coolify: deploy admission (repo:path) | 1 query |
### 3. Accepted imperfections
- A deploy admitted just before revocation finishes; visible in history, person can stop it.
### 4. Ship journey
Press Deploy on a Machine; services start; logs visible; loaded daemon id recorded.
## Design
The daemon trusts the admitted job and stops on its local cancel signal.
