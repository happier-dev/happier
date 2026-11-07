# USAGE-PARITY-1107

**Verdict: IN PROGRESS.** Three loaded UI/native comparisons match; source parity defects are being corrected and focused checks remain queued. Reload 122 is needed to validate newly added commands; this lane has neither restarted nor reloaded the retained QA stack.

## Deliverables and basis

- Inventory: `.project/tmp/usage-parity-1107/inventory.json`; canonical Action exports evaluated by adjacent `inventory.mjs`.
- Current inventory covers 227 semantic control families and 305 callback/forwarding sites, with validation state recorded separately from source wiring.
- Source basis: moving shared checkout; no dependency, persisted schema, or Account default changes authorized.
- Live basis: Account A, own new browser profile on nl1; `agent-qa-usage-insights`, retained reload 121, HMR disabled.
- Runtime and captures: `.project/tmp/usage-parity-1107/runtime.json`, `native-context.json`, `live-spotchecks.json`.
- The three successful pairs ran at 11:13–11:24Z, before the reported 11:51–12:3xZ borrowed-Expo outage; no outage-window failure supports this verdict.
- Systemic's 12:51Z nl3 hold was lifted at 12:53Z; no outage observation supports a parity claim. This lane's nl1 browser was already closed, with no nl3 browser to clean up.

## Native current-context diagnosis

Observed: both exact-browser-client and untargeted native `ui.current_context.read` returned 130 Usage commands after mounting.
Observed: date range, view, and agent filter changed the same browser through native CLI command invocation.
The CLI defaults to its present-user terminal authority; these pairs prove native transport/result parity, not authenticated Session-agent approval authority.
Therefore R48's historical zero-command/unbound-browser claim does not reproduce on this mounted browser.
The browser itself transiently published zero commands before later population; this does not establish R48's historical cause.
The `sameCommandsAsBrowser:false` sampling field compares opaque lists at different times; successful paired mutations establish binding.

| Loaded control | Action | UI result | Native result | Match |
| --- | --- | --- | --- | --- |
| Period: Today | `ui.current_context.command.invoke` | `{relative:today}` | `{relative:today}` | Yes |
| View: Costs | `ui.current_context.command.invoke` | `costs` | `costs` | Yes |
| Agents: Codex | `ui.current_context.command.invoke` | `[codex]` | `[codex]` | Yes |

The initial filter automation timed out while reopening its chooser; the corrected scoped interaction completed the third pair.
An initial chart test command selected the repository root and found no tests; this is invalid RED evidence, and the package-scoped run replaces it.

## Source parity summary

Additional QA evidence: synthetic agent decisions returned `present_user_required`; subscription writes returned `approval_origin_unavailable`. The captured synthetic context had neither Session custody nor a signed approval origin.
The raw historical decision call/policy was not captured; the UI-origin request must not be labeled agent self-approval. Authenticated decisions and the deliberate same-Session prohibition remain required; the separate explicit-Allow/host-request path is under test.
Historically, UI restore Actions `actions.policy.set(default)` and `actions.policy.reset` returned `action_failed` (dispatch / Error, no subcode/status); canonical Account restoration succeeded. Both current real-Home/UI-Action regressions now pass (`authority-restore-owner-repaired.log`, 2/2); the historical cause remains unattributed.
Reproduced independently: an authenticated Session agent with explicit Allow reached HTTP 401 for the subscription-price presentation write. The signed finite writer's route was missing from the existing purpose owner.
The scoped correction recognizes that admitted writer and combines absent-row materialization with its price mutation in the existing presentation CAS; it grants no Settings/acknowledgement/history maintenance writes.
The genuine Session-agent/finite-CLI/server path passed both present/absent-row cases, sibling preservation and signed negative purposes (`authority-agent-green.log`). Explicit-Allow Agent/MCP decisions on person-created host requests now pass 3/3 with default Ask, missing decider, same-Session and same-request denials retained (`authority-peer-ui-green-canonical-2.log`).

| Control family | Action / page command | Agent callable | Same owner | Status |
| --- | --- | --- | --- | --- |
| Period, filters, view | `ui.current_context.command.invoke` / page choices | Yes | Yes | Loaded pairs match; origin propagation under audit |
| Work details, disclosures, retries | Mounted page commands | Yes | Yes | Focused GREEN pending; held-chart business relay remains open |
| Prices and night hours | Mounted controls → declared settings / price Actions | Yes | Yes | Price draft GREEN pending; native finite writer verified |
| Sources / Continue | Mounted controls → external-session Actions | Yes | Yes | 72 cases plus actual agent folder confirmation pass; adjacent checks pending |
| Coach / checks / trigger editor | Mounted controls → declared settings / digest Actions | Yes | Yes | Actual confirming caller retained; overlay discovery gap under test |
| Recap / export / image | Mounted controls → existing Usage Actions | Yes | Yes | 84 focused cases pass; public build remains queued |
| Shared selectors, widgets, modal, charts | Existing local-command composition | Yes | Yes | Generic owners extended; overlay visibility and pending GREEN remain |
| Pacing targets / quota preferences | Existing settings Actions | Yes | Existing settings owner | Session settings only; no reachable Usage control found |

## Validation and ownership

Canonical command publication remains the existing current-context owner; controls and agents consume the same mounted declarations. The folder browser's mutation controls pass 29 cases, but a separate read audit found raw filesystem RPCs beneath the chooser; canonical read admission is being corrected before claiming that corridor complete.
Five APIs need no extra control: `usage.recap.compose/deliver/export` already share the private composer feature; `usage.recap.private.export` exposes bytes behind existing delivery; `usage.prices.get` is the displayed data read. Inventory records each disposition.
Business effects remain existing Action owners; the external-session direct RPC fallback is removed.
Command-driven resource reads are also being routed through canonical Action admission while retaining the existing Resource lifecycle.
Focused evidence: Sources/Coach 72/72 plus real agent folder confirmation; recap/profile 84/84; modal bridge/native/composition 63/63 after removing the unconditional Action-runtime import. Logs live under `.project/tmp/usage-parity-1107/`.
Disabling only two Resource caller-context relays reproduced forbidden HTTP reads; the sensitivity A/B restored its exact hunks afterward. These relays preceded valid RED, so this does not retroactively establish test-first chronology.
The six-suite core batch reached 134 passes and 11 failures; actual price-retirement/prompt REDs and fixture corrections await GREEN. Plans pass28/28; lens owner/series15 plus DOM1; selector foreground5; Project chooser12. Resource6 and actual Page period/filter2 pass, including zero forbidden HTTP and visible `action_disabled`.
Adjacent pagination stopped before collection on the deployment-reference subpath; the integration owner was notified. No dependency repair was attempted here.
Later focused rows stopped before Vitest on the Claude plugin importer/lockfile mismatch; browser collection also exposed an undeclared `session.list.sections` setting. Both prerequisites were routed to Systemic. At 14:14Z Systemic declared lock/install consistent; one corrected retry per row is running. Borrowed Expo remains parked on a separate missing protocol module.
ChartTooltip's real mounted exact-value journey passes after actual missing-command RED; all three existing tooltip interactions also pass, with boundary exports retained and cold imports collected before tests. Lens owner/series15 plus real DOM placement1 pass. Earlier deployment initialization failures were repaired at 15:05Z.
Entry-loads4,5 and8 passed7/7. Run6 passed6/7 on a filesystem export during publication; run7 passed6/7 on the foreign readiness export. Run8 loads both current producers. Network passes without valid pre-producer RED; that chronology exception remains explicit.
No source-fix live pass is claimed from the retained reload-121 browser. Three existing controls were compared in the loaded product.
Committed `332b4603`, `eb0202c1`, `f2269bfd`, `4759d29f`: native-price, Sources/Coach, recap, selectors, Plans, modal bridge, delegated approvals and exact chart values; private index/CAS, compatible foreign hunks named. A further real rapid hover/blur RED now passes6/6; About leaves pass73/73. Remaining controls and adjacent checks continue; final Usage RESULT remains pending.
The shared compiler wave ended with CLI/UI **not run** on Cloudflare declaration preparation; no UI delta proof is claimed or duplicate compiler queued. Plugin-UI's two new public-props assertions concern foreign Collection/DetailsPane props. The 11:42Z ruling keeps focused GREEN + entry-loads as the commit gate; integration owns compiler recovery.

## Residual risk

Reload122 was needed for new source commands; the orchestrator has since begun reload123. No new-source loaded pass is claimed here. Signed-Session filesystem child transport remains an identified production prerequisite; Account-only composed evidence cannot close it.
Physical mobile devices, E2EE price mutation and Safari clipboard gesture behavior have not been exercised in this lane.
Historical R48 causation remains unproven; its current-context failure is not reproducible on the observed mounted client.
