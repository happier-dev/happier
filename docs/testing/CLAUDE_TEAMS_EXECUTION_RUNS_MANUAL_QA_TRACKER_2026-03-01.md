# Claude Teams + Execution Runs — Manual QA Tracker (2026-03-01)

## Scope

This tracker covers full manual end-to-end validation of:
- Claude agent teams / swarms behavior in Happier UI
- Participant recipient routing (Lead, teammate, broadcast, execution-run)
- Claude teammate sidechain transcript visibility
- Execution-run direct messaging (long-lived + bounded)
- Steering behavior (`steer_if_supported`) and fallback behavior (cancel current turn + send)
- Abort + send expectations (turn-level interruption only, not session/run kill unless expected)
- Structured participant-message cards and recipient UX integrity

## Ground Rules

- Validate every scenario on real UI + real Claude backend path (not mocked).
- For each failure: capture reproducible steps, observed behavior, expected behavior, and factual root cause.
- Implement root-cause fixes only; no workaround-only patches.
- Re-run impacted scenarios after each fix.

## Environment

- Date: `2026-03-01`
- Stack URL: `http://happier-repo-dev-a1cc5e0671.localhost:19364`
- Runner: Playwright MCP + local CLI/backend stack
- Primary provider under test: Claude
- Session-mode requirement for test runs: **YOLO/auto-approve tool mode** (to avoid permission-prompt blocking)

## Master Checklist

### A) Session Setup / Baseline
- [x] A1. Create fresh Claude session in YOLO/auto-approve mode
- [ ] A2. Confirm no permission-gate prompts block flow
- [ ] A3. Confirm normal lead messaging still works

### B) Claude Team Lifecycle
- [ ] B1. Create team (`AgentTeamCreate`)
- [ ] B2. Spawn teammate #1 (`Agent`/`Task` teammate_spawned)
- [ ] B3. Spawn teammate #2
- [ ] B4. Send direct message to teammate #1 from session composer recipient chip
- [ ] B5. Send direct message to teammate #2 from session composer recipient chip
- [ ] B6. Send broadcast message from session composer recipient chip
- [ ] B7. Send teammate-directed message from teammate tool detail view (auto-recipient)
- [ ] B8. Shutdown one teammate
- [ ] B9. Verify shutdown teammate no longer targetable in recipient list
- [ ] B10. Delete team
- [ ] B11. Verify broadcast + all teammates removed from recipient list

### C) Sidechain Visibility / Tool Detail Streaming
- [ ] C1. Open teammate tool details while active
- [ ] C2. Verify sidechain messages stream continuously into detail view
- [ ] C3. Verify status updates (idle/task complete/shutdown) render coherently
- [ ] C4. Verify unknown/raw payloads degrade gracefully (no broken rendering)

### D) Recipient UX / Structured Messages
- [ ] D1. Recipient popover lists all valid recipients (Lead, teammates, broadcast, execution runs)
- [ ] D2. Recipient popover applies theme-appropriate colors (dark/light)
- [ ] D3. Sent routed messages render as structured `participant_message.v1` cards
- [ ] D4. Structured cards preserve original user-authored text (no Claude rewrite leakage)

### E) Execution Runs — Long-Lived
- [ ] E1. Start long-lived execution run via `SubAgentRun`
- [ ] E2. Verify run appears in recipient list while running
- [ ] E3. Send message while run turn is in-flight (delivery default: `steer_if_supported`)
- [ ] E4. If steer supported: verify steer path used, run continues
- [ ] E5. If steer unsupported: verify cancel+send fallback works and run continues
- [ ] E6. Verify run remains targetable while still running
- [ ] E7. Verify run removed from target list when finished/stopped

### F) Execution Runs — Bounded
- [ ] F1. Start bounded run
- [ ] F2. While running/in-flight, send routed message to run
- [ ] F3. Verify steer-or-fallback behavior (same semantics as long-lived)
- [ ] F4. Verify bounded run is not incorrectly failed by intentional turn interruption
- [ ] F5. Verify bounded run becomes non-targetable once completed

### G) Regression + Edge Cases
- [ ] G1. Team member id case mismatch handling (`Beta` vs `beta@team`) for removal logic
- [ ] G2. Team member removal from sidechain `shutdown_approved` event without explicit `AgentTeamDelete`
- [ ] G3. Team delete with active members should preserve coherent recipient state
- [ ] G4. No stale recipients after session refresh/reload
- [ ] G5. No stale recipients after switching sessions and returning

### H) Final Validation
- [ ] H1. Re-run all previously failing scenarios after fixes
- [ ] H2. Run targeted automated tests for touched logic
- [ ] H3. Summarize final pass/fail matrix + residual risks

## Live Findings Log

| ID | Status | Area | Scenario | Observed | Expected | Root Cause (facts) | Fix | Re-test |
|---|---|---|---|---|---|---|---|---|
| F-001 | Fixed | Claude team recipient lifecycle | Teammate shutdown via sidechain event | Teammate could remain targetable after shutdown approval | Shutdown teammate should be pruned from recipients | Participant derivation did not consume Agent tool `messages` shutdown events (`type: shutdown_approved`) | Added shutdown-event parsing + robust teammate id resolution in Claude participant derivation | ✅ Targeted unit + live behavior spot-check |
| F-002 | Fixed (code), pending manual re-test | Claude MCP bridge startup | Starting team workflow in fresh Claude session | Claude Agent SDK run failed with `Cannot find module .../apps/cli/dist/backends/codex/happyMcpStdioBridge.mjs`; session surfaced runtime error instead of running tools | Happier MCP bridge must start in dev/source worktree and packaged builds | `bin/happier-mcp.mjs` hard-requires `dist/backends/codex/happyMcpStdioBridge.mjs`; dev stack runs from source and may not have `dist/*`, causing MCP bridge launch to fail | Added source-mode fallback in `createHappierMcpBridge`: if dist bridge entry is missing but source entry exists, run bridge through `node --import <tsx-hook> src/backends/codex/happyMcpStdioBridge.ts` with `TSX_TSCONFIG_PATH`; preserved existing direct/bin behavior when dist is present | ⏳ Re-test in fresh session after daemon/session restart |

## Change Log

- `2026-03-01` — tracker created for full Claude teams/execution-run manual QA campaign.
- `2026-03-01` — logged and fixed shutdown-sidechain recipient pruning defect (`F-001`).
- `2026-03-01` — logged MCP bridge startup failure in source-mode sessions and implemented fallback fix (`F-002`).
- `2026-03-01` — migrated active, detailed execution matrix + live findings to `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_DETAILED_2026-03-01.md`.
