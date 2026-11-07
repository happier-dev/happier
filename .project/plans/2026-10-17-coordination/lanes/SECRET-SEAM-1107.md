BLOCKED — live smoke refused agent_startup_invalid_state (undefined debug), before secret/card creation; daemon startup repair required. Focused implementation committed e0e9f478bf; full CLI file has one foreign secrets.usedBy failure.

| Check | Verdict | Evidence |
| --- | --- | --- |
| Canonical owner discovery | Observed | `packages/protocol/src/actions/actionInputHintsRuntime.ts`, `executor/confidentialInputs.ts`, `executor/confidentialContinuation.ts` |
| Private material execution | Observed | `apps/cli/src/daemon/surfaces/confidentialSecretFill.ts#createConfidentialActionInputsExecutor` |
| Existing card | Observed | `apps/ui/sources/components/approvals/ConfidentialSecretApproval.tsx` and `confidentialSecretApprovalModel.ts` |
| Protocol RED | Failed as intended, 4 tests | `.project/tmp/SECRET-SEAM-1107/red.log`: missing inputs rejected, identity MCP absent |
| Protocol GREEN | Passed, 6/6 | `.project/tmp/SECRET-SEAM-1107/red-local.log` |
| Composed Saved Secret storage | Passed through real executor/private RPC/resource sealing; returned id equals stored resource id | `.project/tmp/SECRET-SEAM-1107/composed-green-3.log`; full-file 10 passed, 1 foreign failure |
| Full CLI neighboring file | 10 passed, 1 foreign test failed: unregistered `secrets.usedBy` | `composed-green-3.log`; ASK posted Coordination/Providers; foreign test rewrite excluded from commit |
| Canonical Connected Account census | Passed, 1/1 | `.project/tmp/SECRET-SEAM-1107/census-green.log`; user-authorized test-only composite-id adaptation; Providers FYI posted |
| Supplied credential custody RED | Failed as intended, 3 leaks; 6 neighboring cases passed | `.project/tmp/SECRET-SEAM-1107/red-custody.log` |
| Supplied credential custody rerun | 13/15 passed; provider replay mistook safe projection for missing input | `.project/tmp/SECRET-SEAM-1107/custody-green.log` |
| Supplied credential custody GREEN | Passed with admission, 15/15 | `.project/tmp/SECRET-SEAM-1107/custody-green-3.log`; real decision CAS and retained execution; prior fixture omitted transport acknowledgment |
| Real masked card | Passed, 2/2; restored explicit Machine HTTP fixture ahead of empty bootstrap | `.project/tmp/SECRET-SEAM-1107/ui-green-2.log`; prior `ui-green.log` 2 failures; first invocation found no tests |
| Entry-loads 7/7 | Passed on current source after helper delta | `.project/tmp/SECRET-SEAM-1107/entry-loads-2.log`, terminal exit 0 |
| Adjacent declarations | Passed, 82/82 | `.project/tmp/SECRET-SEAM-1107/adjacent.log` |
| Live Account A journey | BLOCKED before secret request: `agent_startup_invalid_state`, undefined `debug` | `.project/tmp/SECRET-SEAM-1107/live/result.txt`; Account A sign-in succeeded; Machine5ac7 online; own smoke Session archived; browser closed |
| Loaded runtime | LIFTED sourceTime17:56:16Z; server `be5482e8166388b9` source17:55:59Z | Daemon selected `05f1708a3be84105`, loaded=null; Coordination confirmed running from run log/runtime; actual smoke is deciding failure |
| Requested live model | Codex `gpt-6-luna` observed; low reasoning NOT independently confirmed | Composer displayed plan; no agent turn ran. Retry must confirm low reasoning |
| Package typecheck | Not run by this lane | Coordination owns the integration-wave baseline/delta; no zero-delta claim |
| Commit | `e0e9f478bf268d6cc98a55482340b0d136e7d93f` | Private index + commit-tree/CAS; shared index untouched; no push; census assertion named in message |

Observed ownership and consumers:

- Action declarations decide confidential paths once; caller binding and executor share that admission result/helper.
- Missing required operands become a value-free approval, whose existing private continuation accepts Once/Saved Secret choices.
- The CLI materializer executes with private inputs and redacts results; the existing personal Saved Secret host seals/writes the resource. The private result retains its usable id; its secret-named reference field is redacted.
- UI/CLI/Agent/MCP share those Action declarations. Direct CLI retains its existing hidden input adapter.
- RU2 SECRET-FILL-FIX-1107 fixes native-fill refusal presentation in this same continuation; it is not another secret-request owner.
- O-DEPLOY's planned Variables Ask consumes this declaration/card/continuation. No second implemented Variables card was found; no competing card was added.
- Managed identity uses `clientSecret`; WorkOS API keys belong to Home settings. Directory/WorkOS connection Actions select configured connections and carry no new credential operands.
- Raw identity surface flags in the earlier audit were stale evidence: normalization already admits present-user consent requests. Preserve the authority floor.

Authorization/credential deltas for the Opus batch (committed; independent security batch not run by this lane):

1. Saved Secret create declares `value` as confidential when no source was selected; optional update values remain confidential without asking during metadata edits.
2. Missing-only create validation is attributed to `value`; the complete executable schema still requires exactly one value/source and retains vault/passkey constraints.
3. Managed provider create/secret replacement declare required `clientSecret`; existing present-user authority and consequential approval remain.
4. Identity/Home identity/Team directory setup enables Agent/MCP exposure under the existing approval policy; no new approval policy or authority grant.
5. Home setting secret replacements derive from the canonical server config registry, including WorkOS API keys; clear and ordinary setting writes do not manufacture secret questions.
6. Missing-secret admission recognizes a union only when one entire branch fails solely for omitted declared confidential leaves; malformed public fields continue to fail admission.
7. Reproduced supplied-credential retention for provider create/replacement and Home settings; those Actions now use existing live-only custody and safe observation/review projections. Direct settings writes retain their confirmation policy; when approval is required, the invocation waits with its private operands.
8. Decision/replay consumes the admitted `preview.confidentialInputs` question. A redacted live-only projection no longer becomes a second missing-secret question. Native secret-fill still always requires its private continuation.

Net mechanism delta: one existing owner; +0/−0 states, error codes, timers, retries, policy modes and dependencies. +1 union branch in the existing missing-input classifier allows omitted Home secret leaves; −2 missing-input re-decisions at approval/replay consume the admission marker instead. Commit touches 13 files, adding 2 test files and removing 0 files. No new secret-request Action, card, credential store or coordination mechanism.

Residual risk: the loaded runtime refused agent startup; card capture, live secret storage, transcript non-disclosure and deletion were not reached. No live secret exists to delete. Own Session `cmw6qvfb2003gmcp31akjna4c` was archived (Unarchive control observed); browser controller reclaimed its temporary root. Coordination must repair startup, then retry the same journey with confirmed low reasoning. Full-package typecheck/security batch remain integration-owner checks. Foreign manifest/lockfile drift was left untouched; Systemic owns it.
