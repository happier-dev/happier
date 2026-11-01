IMPLEMENTED — Session Agent admission and typed recovery fixed; composed/live verification remains blocked below.

Voice ORCH / RUN62D: reload the UI once, then replay Global Start → Send. No stack restart is needed or was performed.
With unreadable bound Session Agent metadata, Start must show the selection reason and Settings recovery before capture; with a readable Agent, Send must use that admitted Agent.

Observed cause and evidence:
- RUN62D's original evidence: `evidence/final62d/restart83-row1-first-failure.json` under this plan; Start listened, Send rejected `VOICE_AGENT_SELECTION_UNAVAILABLE`, zero model starts.
- Read-only loaded-runtime probes: `.project/tmp/voice-agent-from-session-1101/live-owner-input.json` and `live-bound-input.json`.
- Carrier `cmvtcf30b002cmc1ec2tph6qz` has readable layout-1 Codex owner metadata. The retained binding instead targets `cmvxmuckn0085mcz26411dw8s`, whose owner metadata and canonical Agent result were unavailable.
- Derived: carrier preparation admitted capture while Agent inheritance was deferred to Send and followed that unreadable coding root. Carrier health therefore did not establish execution selection. The original Send's exact internal throw stack was not captured.

Changes and ownership:
- The Session Agent owner remains `resolveSessionActionDefaultBackend`; `voice/agent/resolveVoiceSessionAgentSelection.ts` adapts its result and canonical operational projection into one typed Voice selection.
- `VoiceExecutionTransport.prepareAgentSelection` hydrates missing owner facts, admits selection before capture, and retains the target through Send, rearm and handle recovery. Stop / Account retirement releases it.
- `localVoiceEngine.ts:561` consumes preparation before either capture entry. Text-only initialization uses the same owner when there was no capture admission.
- `initializeVoiceAgentHandle` and `resolveDaemonVoiceAgentModels` consume the admitted target; duplicate initializer checks and the model reader's independent Agent projection were removed.
- The existing machine error classifier and reason-copy owner consume the typed refusal: setup error, selection-unavailable copy, Settings recovery. Existing translation tables were extended in all 12 locale files; no new mapping table was added.
- Fixed-Agent / Provider Chat selection remains with its existing owner. Carrier creation/resume are separate admissions; credential-target matching remains a credential attribution check, not an Agent fallback.
- Affected surfaces: Local conversation Global/session Start, microphone rearm, first/delayed Send, text-only entry and recovery; shared web/native path. Direct-session capture and realtime transport do not use this Agent admission.
- No wire, settings or persistence format changed. This corrects existing selection/error semantics; no canonical product documentation change was needed.

Verification (all commands dispatched through `./apps/stack/bin/hstack-exec`):
- Constructed RED: `admission-red-local.log` rejects the already-admitted Codex selection at the old initializer check. Its unrelated sparse-settings teardown failure was fixed with the canonical settings parser.
- Constructed RED: `red.log` shows generic provider Retry instead of setup recovery; `copy-red.log` shows generic setup copy instead of the selection reason.
- Constructed RED → GREEN for rearm: `rearm-red.log` / `rearm-green.log`; second preparation must retain the admitted Agent after metadata disappears. Final targeted regression result: 3 passed.
- Focused GREEN: `green-final.log`, 4 files / 79 tests passed. Includes initializer, configured ACP / bound-root cases, daemon model selection, error classification and reason copy.
- Final recovered-source GREEN: `resume-focused-remote.log`, 4 files / 80 tests passed, terminal exit 0.
- Capture/Send reason GREEN: `capture-reason-red.log` / `capture-reason-green.log`, 2 files / 39 tests passed; the existing copy owner accepts both public code and safe-message casing.
- Entry loads: `entry-loads.log`, 7/7 passed (daemon preparation, daemon, CLI, Voice inference worker, server, UI catalog, SDK browser).
- [blocked] Composed adapter checks: final rerun `resume-adapter.log`, 2 failed before reaching this admission at carrier creation with `admission_unavailable`. The same barrier affected three pre-existing adapter tests in `red.log`; no internal owner was mocked to bypass it. ORCH must resolve the Action admission barrier and rerun this suite.
- [blocked] Package typecheck: `typecheck.log` contains package/dependency diagnostics, none in Voice. Its runner handle was lost across the account-limit interruption; no terminal pass is claimed. ORCH owns package-green validation.
- Commit-slice check: final `final-slice-coherence.log` reports 10 shifted locale errors (INCOHERENT). Diagnostic logging (`resume-commit-diagnostics.log`) proves base/head 23 each, zero new semantic diagnostics, all 10 identical errors shifted one line. An earlier run also reported 2 unrelated diagnostics in PluginAppPageScreen.test.tsx:729 and WorkflowStepDataEditor.tsx:406; neither recurred. The checker was not weakened.
- A remote RED attempt lost SSH (`admission-red.log`); deciding RED/GREEN ran locally through the wrapper. Logs above are in `.project/tmp/voice-agent-from-session-1101/`.
- Resume-local rerun (`resume-focused.log`) lost the Vitest worker module after two suites passed; the successful fresh executor-host rerun supersedes it.

Self-review and mechanism delta:
- Self-review found and removed re-admission on microphone rearm; its regression is RED → GREEN. Repeated carrier test fixtures now retire their lookup rows, avoiding cross-case stale Agent facts.
- Selection checks: +1 before capture / −3 repeated initializer refusal checks. Attempt state: +1 retained selection map, needed because Start and Send are separate gestures in the reproduced failure; lifecycle uses existing Stop and Account retirement. Error codes, timers and retries: +0 / −0. Files: +1 selection adapter and +1 requested report / −0.
- Split-brain audit: selection and model consumers share the Session owner adapter; no saved-Agent fallback was introduced. Separate spawn admission and credential attribution paths are intentionally retained for their distinct effects.
- Commit uses only this lane's hunks in a private index with compare-and-swap HEAD advancement; shared index and unrelated work are preserved. No push.

Residual risk / next action:
- Live replay has not run on the patched bundle. RUN62D owns the existing QA page; its settings were already changed to explicit Agent by its own later work, so this lane did not reload or alter that page.
- Reload once, restore the authorized Agent-from-Session recipe, and replay both unreadable and readable selection cases. The visible unavailable case is recoverable by selecting an Agent in Voice settings or restoring the target Session's owner projection.
- Web/native presentation shares the tested copy owner; physical-device presentation was not exercised. Composed adapter proof remains blocked by the pre-existing Action admission failure.
