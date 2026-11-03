STATUS: IMPLEMENTED — current-source RED→GREEN; standalone commit coherence [blocked] below.

Lane VOICE-GPTLIVE-ADAPTER-1103; current moving checkout, 2026-11-03.
Observed cause: the Account-scoped Voice path delegates provider activation to
AppShell. Its current per-machine projection hooks had become passive (`load:false`),
but selected/active Voice demand reached only executable selection, not acquisition.
A cold shell therefore never obtained the declaration/bundle needed to register
the adapter. Descriptor visibility alone did not establish an executable adapter.

History: `afe5cc0949` (2026-11-02, keep disabled plugin runtimes cold) removed eager
assembly activation and assigned Account activation to AppShell. `git log` since
2026-10-26 and blame identify the passive hook conversion as current uncommitted
work, not a released commit. The failure is the missing demand across those changes;
no moved Codex export, missing public registration, or feature decision was found.
Basis: `VoiceSessionRuntime.tsx:319`, `registerBuiltinVoiceAdapters.ts`, and
`AppShellPluginUiProjection.tsx:494`; RUN63 A1–A3 / restart91 remain the loaded evidence.

Fix: AppShell feeds selected/active qualified-provider demand into its existing
per-machine currentness hook, including the dedicated Voice-machine path.
Only that machine acquires declarations. Generic client-executable activation and
the existing external-registration registry still publish the adapter. No provider
id special case, Voice-only re-registration, gate, timer, retry, or native RPC change.
Local/Off selection alone keeps observers passive; an active provider retains demand.

Constructed composed RED: removed `PresentedFixtureMachineTargets` prewarming from
the real mounted-shell Voice test; registration stayed null (1/1 failed).
GREEN: that same cold-shell registration test passed, including host replacement,
offline withdrawal, reconnect and target changes; unrelated machines were not read.
Logs: `.project/tmp/voice-gptlive-adapter-1103/{red,green-shell}.log`.

Broader checks: shell 53/54; failure is the existing offline Action artifact-retention
assertion (`AppShellPluginUiProjection.test.tsx:2002`), outside Voice registration.
Codex composed + demand: 11/13; two Global binding cases return `admission_unavailable`
instead of their expected downstream errors. That suite does not mount AppShell;
these are unchanged-path failures, not evidence that Global audio now works.
Logs: `green-codex.log` in the same evidence directory.
Pre-change adapter/projection baseline: 25/32 (tool session 64180); six qualified-Agent
race cases timed out and speech descriptor expected an absent recipient-contract digest.
Those independent failures were not changed or hidden.

Entry loads: PASS 7/7 via the exact requested hstack-exec entry-load command.
`entry-load.log` records daemon preparation, daemon, CLI, Voice worker, server,
UI catalog and browser SDK. Package typecheck intentionally not run (user instruction).
Focused deciding run: PASS 4/4 (`green-focused.log`): cold shell, native direct composed,
generated public adapter entries, and selection/active-provider demand retention.
Commit coherence: FAILED, 2 new TS2353 diagnostics, one invocation (`coherence.log`).
[blocked] HEAD lacks the existing worktree's `usePluginUiProjectionCurrentness.load`
API. Integrate its canonical owner change before treating this slice as standalone;
no second coherence check or package typecheck was run. Unrelated work was not committed.

Intended product behavior: published development docs `apps/docs/content/docs/voice/index.mdx`
lines 347–352 and 483–496 explicitly support Home/Global through an exact matching
hidden Codex Session, selected machine/directory/permission/account, with no fallback.
Direct Voice attaches to the opened Codex Session. No contract was found for directly
attaching Codex realtime to OpenCode/Claude; existing qualified-Agent refusal remains.
This does not require hiding the provider picker on other Sessions; no such policy
was invented. Hidden-Session/binding implementation was not expanded.

Split-brain audit: kept one Account activation owner (AppShell), one machine-currentness
owner and one external-registration publication path. The source-only assembly bridge
remains intentionally inactive under Account authority; it is not an Account fallback.
No documentation change is needed: this restores the documented registration path.
Net delta: +1 demand predicate / −0 checks; +0 states/errors/timers/retries;
+0 production files / −0 production files; +1 requested report. The predicate prevents
the reproduced missing acquisition; it uses the protocol-owned qualified-key parser.

Residual risk: no loaded-runtime replay or real audio claim. UI source only: reload
the UI, then replay RUN63 A1 and A2 against the existing runtime; no server/daemon
restart or rebuild is required by this patch. Global binding failures may remain
after registration succeeds. No stack lifecycle or live credential/settings mutations.
