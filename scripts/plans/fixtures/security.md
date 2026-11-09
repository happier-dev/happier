# Account disclosure — PLAN
## Gate
### 1. Flows
| Flow | Who | Steps | Calls per operation |
|---|---|---|---|
| Open content | Account owner | request → mode owner → disclosure | 1 mode decision |
### 2. Mechanism ledger
| Mechanism | Owner (one place) | User-visible harm without it | Reachable how | Reference that does it OR Happier-specific requirement |
|---|---|---|---|---|
| Fail closed on mode mismatch | Account mode and envelope owner | E2EE content disclosed as plain | mismatched envelope input | Happier requirement: preserve Account encryption mode |
### 3. Accepted imperfections
The person retries after repairing unavailable key material.
### 4. Ship journey
The Account owner opens content; mismatched envelopes return the owner's typed refusal.
## Design
The Account mode and envelope owner decides current authority and fails closed before disclosure.
Quoted evidence: `every read rechecks currentness` describes the removed consumer check.
## Execution tracking
STATUS: IN_PROGRESS
2026-10-31 12:00: tests PASS; loaded-runtime QA still running.
