DONE — 668954ff01c1f6b648d176bbb4f60a2b6988d29c; brief gate passed: focused owner checks and AUTO entry-loads 7/7. Broader checks handed off below.

# SEC-FOLLOWUP-1107

Scope: SEC-COORD-1107 findings 2–10. Finding 1 / `resourceGrantAccess.ts` untouched.
Evidence directory: `.project/tmp/SEC-FOLLOWUP-1107/` (log names below).

| Check | Verdict | Evidence |
| --- | --- | --- |
| Forged retained role, plain/E2EE | RED → GREEN, 2 passed | `role-red.log`, `role-green.log` |
| Receipt from another Workflow Run | RED → GREEN; recovery owner 42 passed | `receipt-red.log`, `receipt-green.log` |
| Coordinator / detached execution / settlement / lost operation | Passed | `receipt-green.log` |
| Affected Discussion recovery | 16 passed after supplying original Run in fixture | `receipt-session-green.log` |
| Artifact boundary mock and signed replay | RED → GREEN; 1 + 2 passed | `cli-approval-red.log`, `cli-approval-mock-green.log`, `cli-approval-green.log` |
| Real Artifact owner, plain/E2EE | 2 passed; outsider denied | `cli-artifact-owner.log` |
| Canonical requester admission | Passed; Carol denied, Bob admitted | `cli-requester-owner.log` |
| Workflow admission/replay/reservation owners | 35 passed; same batch has 7 requester-fixture failures | `daemon-green-focused.log` |
| Accepted-step authority cost | 7 passed; zero per-input reads, one at resume | `daemon-step-authority-green.log` |
| Managed installation registered RPC | RED → GREEN; 33 passed | `server-installation-red.log`, `server-installation-green-current.log` |
| Project Open authorization owner / current transports | 22 / 6 passed | `server-workspace-owner-before.log`, `server-workspace-owner-current.log` |
| Adjacent workspace SOURCE/TARGET | 27 passed | `server-workspace-adjacent.log` |
| AUTO entry-loads | 7/7 passed, exit 0 | `entry-loads.log` |
| Public CLI / server typechecks | Pending, sessions 33298 / 99623; no delta baseline claimed | `cli-typecheck.log`, `server-typecheck.log` |
| Broader Session suite | 9 failed initially; affected recovery case fixed and rerun | `receipt-green.log`, `receipt-session-green.log` |
| Broader Artifact + Workflow composition | 164 passed, 1 failed at native launch | `receipt-composed-green.log` |
| Adjacent remote-decider | 7/12 failed; Machine boundary/admission fixtures | `cli-approval-green.log`, `cli-remote-decider-green.log` |
| Contributed replay selection | 13 failed / 2 passed; narrower diagnostic 8 failed / 2 passed | `contributed-replay-green.log`, `daemon-composed-replay.log` |
| Publication replay fixtures | 4 failed before replay: run_access_denied | `daemon-wiring-green.log` |
| Bootstrap cancellation custody | Failed: expected pending, observed settled before replay | `daemon-step-green.log` |
| Account-bound daemon ingress integration | Pending, session 12250 | `daemon-startup-integration-green.log` |

## Delivered ownership changes

- #2: `externalActionHandoffAdmission.ts` derives manage/use from the Machine owner;
  retained role disagreement is refused, while exact installation/content checks remain.
- #3: `actionApproval.ts` requires Run identity at every caller, including detached
  execution and recovery evidence. Artifact, invocation, action and Run must match.
  Recovery without a Run cannot settle an approval; non-approval observation is unchanged.
- #4: the CLI HTTP Artifact mock refuses non-owner reads, matching the real server owner.
- #5: accepted Session startup keeps local cancel/lifecycle and stamp identity checks;
  it no longer lists accepted principal token/plugin custody for each step.
- #6: approval replay stops re-admitting Workflow principals; deleted callback wiring
  and trusted-plugin source-custody checks. New Action admission still owns API and
  mediated-source admission. Kept editable Discussion reservation correspondence,
  using the existing recovery owner: removing it would admit forged invitation pointers.
- #7: three workspace-sync operations keep target/installation correspondence without
  repeating their original full admission; initial admission remains authoritative.
- #8: installation responses use the socket's admitted identity and narrowed authority;
  managed enrollment ownership/purpose and receiving installation remain checked.
- #9/#10: deleted CLI requester/decider Account copies; protocol requester-proof
  admission and server Artifact access remain their respective deciding owners.
- Internal `docs/cli-architecture.md` now distinguishes admission from accepted replay.
  No wire/persistence schema, public feature, gate, dependency or runtime file was added.

## Net mechanisms and limitations

Checks: +1 retained-role correspondence / −10 repeated or optional authority paths
(step principal, replay principal, plugin custody, three workspace admissions, handshake
verification, two CLI Account copies, unbound receipt branch). Mandatory receipt binding
reuses the existing settlement check. States/error codes/timers/retries: +0/−0.
Reservation custody wiring moved to its existing correspondence owner, not duplicated.
Shared compatible fixture/startup/credential hunks are preserved in the coarse commit;
it captures four existing untracked test files. No shared-index write or push occurred.
Coordination's next integration boundary owns the three existing pending handles:
public CLI/server `typecheck` scripts and the runtimeCatalog integration selection
`mounts the Account-bound public Action ingress`. Resume existing handles; AUTO memory
and workspace publication admission are the prerequisites. No pending check is a pass.

Residual risk: broader failures are observed, not proven historical. Session/native launch
failures occur before settlement; requester-fixture failures precede replay, four publication
cases lack signed admission, and Channels has a cursor projection mismatch. Bootstrap
cancellation custody also differs from its fixture expectation; no historical cause is claimed.
No stack restart, loaded-runtime/browser QA or native Windows/macOS run was performed.
