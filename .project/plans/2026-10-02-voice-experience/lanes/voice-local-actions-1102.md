STATUS: DONE — focused validation complete; broader package limitations recorded below
Lane: VOICE-LOCAL-ACTIONS-1102; checkout: /home/leeroy.guest/.happier-stack/workspace/0.3

Outcome: Local turns discover and invoke canonical settings and approval Actions;
catalog operands survive privacy projection and owner refusals explain the tap.

Observed cause and ownership:
- Both Actions were registered on Voice; no Local-only registration/allowlist fix was needed.
- The canonical settings.list hint supplied no page ids or omit-to-discover guidance.
  The real five-result "voice settings" search omitted settings.list.
- approval.request.list was absent from the prompt's documented hot-path tools;
  its workflow mentioned the name without supplying an invocation definition.
- With path sharing off, provider redaction erased catalog path: "pageId" as a
  filesystem path; summary privacy also stripped declaration titles/labels.
- Generic action_execute results did not select the target's privacy classification.
- The owner's present_user_required refusal was spoken as the raw error code.
- RUN62G did not retain the model's exact discovery query. These are reproduced
  catalog/prompt defects, not a claim about an unrecorded model reasoning trace.

Deliverables:
- packages/protocol/src/actions/specs/settings.ts derives known page ids from
  BUILT_IN_SETTINGS_DECLARATIONS_V1; pageId remains open to contributed pages.
- packages/protocol/src/actions/specs/approvals.ts documents list with get/decide.
- Shared Voice guidance follows the spoken-confirmation ruling; no extra ask.
- spokenActionOutcome.ts presents the owner's refusal with localized tap copy
  in all locales, without rechecking Voice delegation or changing authority.
- The existing provider redaction owner distinguishes declaration labels/schema
  operands from private Session summaries and actual filesystem strings. Generic
  calls reuse resolveVoiceExecutionToolName and the existing envelope projector.
- Real Local turn regression discovers returned page/binding/anchor/request ids,
  invokes the existing owners, checks saved Balanced and executed request state,
  preserves an open request when delegation is off, and rejects false success.
- docs/actions.md records the shared discovery and refusal behavior.

Validation evidence: .project/tmp/voice-local-actions-1102/
- discovery-red.log: expected search/prompt failures; 28 existing tests passed.
- refusal-red.log: both direct and generic transports exposed raw present_user_required.
- catalog-projection-red.log: composed validation caught my invalid static-option
  hint; corrected to text guidance, preserving contributed page support.
- catalog-green.log: canonical search plus strict external projection PASS.
- privacy-red.log: three failures reproduce erased operands and declaration labels.
- final-ui-green.log: 83 PASS (23 composed Local turns plus 60 privacy/outcome tests).
- prompt-final.log: current-source prompt suite 29 PASS.
- cli-composed-current.log: real Manager/client approval path 4 PASS; an earlier
  collection failure in foreign bot-template translations cleared on retry.
- entry-loads-final.log: requested current-source entry-load command 7/7 PASS.
- protocol-typecheck.log: public package typecheck PASS, zero diagnostics.
- protocol-adjacent.log: 10,871 PASS / 22 FAIL in desktop/catalog/approval census
  outside this change; the focused discovery/guidance cases pass. Not a clean baseline.
- UI typecheck emitted dependency diagnostics outside lane files; agents typecheck
  remains queued for worker memory. Neither is claimed green (see their logs).
- coherence.log owns the single authorized candidate check and CAS commit;
  the finalizer commits only on zero new diagnostics, replaying moved HEAD safely.

Split-brain audit: canonical declarations -> Action metadata -> shared prompt,
native discovery and client handlers. Existing Local/realtime transports consume
the same owners; neither owns a separate settings or approval catalog. The existing
approval owner still decides delegation and returns present_user_required when off.
No runtime registration, permission owner, persistence schema, feature gate or
per-turn allowlist was added. CLI production and native Codex exclusions are unaffected.

Mechanism delta: +1 refusal-presentation branch; +1 catalog classification and
optional schema-path mode at the existing privacy owner, justified by reproduced
erased operands; +0 authority checks, states, error codes, timers, retries/budgets;
-0 runtime mechanisms; +3 test files. Metadata exposes existing capabilities.

Self-review: arbitrary contributed page ids remain supported; strict discovery
projection is exercised; speech follows saved owner results; real paths and
Session titles stay private. Existing transports consume one catalog/privacy owner.
No stack lifecycle, process kill, branch switch, shared-index staging or push.
Commit: private-index CAS finalizer output in coherence.log (no push).

Residual risk: no new loaded Codex/provider replay yet. Reload the UI and renew
the Local Voice runtime with these sources, then replay RUN62G rows 17/3 ON/OFF.
The exact next model response remains a live-validation obligation.
