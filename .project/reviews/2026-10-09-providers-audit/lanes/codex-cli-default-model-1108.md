STATUS: DIAGNOSED_NO_CHANGE_REQUIRED — native account/model refusal is already typed and actionable; ORCH live replay remains owed.

The incident is case (a): Codex refused `gpt-6.1-sol` for the selected account. Current source already carries the model refusal to the Session presenter; the reported title is its localized typed-error title. No production change or silent model substitution is justified. Free-tier specificity is not independently established by the retained logs. Package typecheck was not run, as briefed; loaded-browser replay belongs to ORCH after reload.

Evidence folder: `.project/tmp/providers-audit/codex-cli-default-model-1108/`.

| Check | Verdict | Evidence |
| --- | --- | --- |
| Original incident correlation | OBSERVED: Session `cmw7xj3c200a3m2vkzbi67asu`, 2026-11-08 14:31:02 UTC; upstream `model_not_found`, host `provider_model_not_found`, `failureReason: plan`, nonretryable turn failure | `incident-name-only.json`, source daemon log lines 16241–16243 |
| Account/model scope | OBSERVED: same Session; reported profile `705530f2-81e8-4ba2-bc7b-7929a4b95b5a`, `quotaScope: model`, `providerLimitId: gpt-6.1-sol`, `recovery_action_required` | same projection, source line 16342 |
| Default resolution | OBSERVED source: `default`/unset becomes null at native launch; thread/start omits model, then accepts native model readback. DERIVED: native Codex settings choose the default; this path does not resolve a saved Happier catalog row or alias | `packages/plugins/codex/src/agent/runtime/appServer/native.ts:125`; `runtime.ts:2670`, `runtime.ts:2825` |
| Provider refusal versus stale catalog | DERIVED from provider code + plan reason + model-scoped recovery: an account/model entitlement refusal, not an absent cached catalog row. Original private upstream prose is redacted; do not infer that all Free accounts refuse this model | incident projection; `turns/failure.ts:679`; `auth/services/runtime/auth/failure.ts:347` |
| Classification regression coverage | PASS: 63/63 existing Codex turn/auth tests, including captured-shape flattened `model_not_found` and `gpt-6.1-sol` ChatGPT entitlement fixture | `classification-tests.log` |
| Native failure and explicit recovery | PASS: 1 selected test; 104 intentionally skipped. Real native transport -> host lifecycle emits typed choose-model failure, settles the turn, excludes private payload and permits explicit model recovery | `native-refusal-tests.log`; `runtime.nativeAttach.test.ts:1084` |
| Session presenter and Provider recovery | PASS: 77/77 across 3 files; Vite reports existing duplicate translation-key warnings, with no test failure | `presentation-tests.log` |
| RED / entry-loads / package typecheck | Not run: no production or TypeScript edits, so no new RED is needed; package typecheck explicitly owned by ORCH | diagnosis-only change |
| Live replay | OWED to ORCH: agent-qa-providers r1107z, Codex CLI-default on codex4; verify typed cause, choose-model/account guidance and explicit supported-model recovery after reload | original brief; no paid turns or lifecycle operations performed |

Canonical ownership and split-brain audit:
- Native model selection belongs to Codex; `readInitialModelId` passes through an explicit selection and delegates `default` by omission. Catalog probing only lists choices (`lifecycle/preflight/sessionControls.ts:212`). Provider-bound explicit models intentionally use their binding and are not another native-default owner.
- Native error-envelope parsing belongs to `turns/errorPayload.ts`; `turns/failure.ts` owns typed classification; `runtime.ts:714` publishes the issue and model-specific choose-model preview. `SessionRuntimeFailureCauseV1` retains the cause through the host lifecycle.
- `sessionRuntimeIssuePresentation.ts:114` delegates typed Provider errors to `providers/connection/errorPresentation.ts:165`; `providers/errors.ts:93` owns nonretryable `choose_model`. English title/description are `en.ts:7155`. The observed "Model is no longer available" is already localized presentation, not raw vendor prose.
- No competing Codex default resolver, new catalog refresh, alias mapping, fallback, or model replacement was added. Existing account-pool recovery is retained; this lane did not change its behavior.

Same-shape sweep: loss of model-unavailable identity at native terminal-error projection — 3 native owners inspected: Codex already typed (tests above); routed to Providers ORCH: Claude `runtime/issues/runtimeIssues.ts:162` uses `claude.provider.failure` for non-limit failures, and OpenCode `runtime/server/runtimeController.ts:1316` uses `opencode_provider_session_error` for provider Session errors. These are source-observed generic projections, not independently reproduced model-refusal defects; obtain each vendor's actual model-refusal fixture before changing classification. Claude `nativeRuntime.ts:325` retains its issue code; OpenCode `sessionRuntime.ts:80` delegates its issue projection. Shared ACP `DefaultTransport.ts:101` already supplies model-specific guidance for its recognized stderr shapes. Server/daemon catalog-miss writers emit typed `provider_model_not_found`; they are distinct preflight owners, not native default resolvers.

Net mechanism delta: production checks/states/codes/timers/retries/files +0/−0; report files +1/−0. No new tests, schemas, dependencies, limits, caches, polling, or source changes. Existing source changes belonging to other lanes were preserved.

Self-simplification: adding refresh, aliases or a second default-model resolver would not address the observed provider refusal; the existing owners and tests already serve the requirement. The native recovery test is the falsifier for a typed-code-only claim that still leaves a turn stuck.

Residual risk: no loaded-browser replay, no fresh provider call and no proof of a Free-only restriction. Account name codex4 comes from the original run report; logs independently identify its profile UUID. ORCH must run the named replay against its loaded runtime and adjudicate the two sibling classification leads with real vendor-shaped evidence.
