> **FIXED / SOURCE GATES PASS** — cold visible Home Bot rows acquire their final-reply preview without opening the Session. Source commit: `fe51526a3e04d96f9fb71cdf5c41663452d265e7`.
> **INTERMEDIATE HANDOFF:** shared UI compiler gate deferred to the Bot templates orchestrator / Systemic next integration wave: retain run `3681` and consume `typecheck.log` before launching another check; no compiler verdict claimed. Loaded QA replay belongs to the Bot templates orchestrator / FINAL-QA on their existing stack. This is not a package-GREEN or loaded-QA completion verdict.

| Row / path | Observed result | Evidence |
| --- | --- | --- |
| Cold visible completed Bot | Preview appears before opening; one message read, no read-state write; transcript remains incompletely loaded | `home-green.log`, cold-visible test |
| 3,391-row inventory; 20 completed Bots; 2 visible | Exactly 2 preview reads, 1 row each; 18 offscreen Bots and 3,371 ordinary Sessions cause no preview read | `home-green.log`, large-inventory test |
| Empty result response | Existing unavailable subtitle remains; row stays openable | Same large-inventory test |
| Cold secondary Home, without a full Session carrier or Turn projection | Exact metadata/Turn acquisition then one preview row; no inventory delta or full-transcript consumer | `green-final2.log`, `full transcript: false` |
| Open receipt, completed / in progress | Existing full transcript acquisition, completion and pushed reply revisions remain working | `green-final2.log`, `full transcript: true` |
| Warm preview and ordinary content demand | No network reads or unrelated token renders; hidden demand releases; existing list-demand cases pass | `green-final.log`, `demand-adjacent.log` |

## Cause and owner

- **Observed source:** `useInboxReadySessionResult` used the unsettled metadata-only `useSessionContentDemand` path. Readable list metadata was already settled, while `Sync.hydrateSessionListRows` explicitly passed `hydrateMessages: false`. Nothing acquired a cold final reply.
- The same demand owner now carries the selected result Turn through exact acquisition. `readInboxReadySessionTurnId` is shared with the existing result selector, preserving once-delivery versus latest-Turn selection and content admission in one owner.
- A small Session message adapter reuses `runSessionMessagesPagePipeline`, exact-Home request authority and explicit plaintext/E2EE handling. It fetches the one final assistant anchor already consumed by the preview, suppresses transcript lifecycle events, and does not change transcript pagination/window state or mark the transcript loaded.
- Home consumes the existing presentation and measured-viewport owners through `Item.pressableRef`. No wrapper, row structure, styling, typography or copy was added by this fix.
- Both Home entry points consume `HomeCompletedBots`; investigator receipts retain their existing explicit full-transcript path. Ordinary Inbox rows do not display result previews and retain metadata-only demand. Existing warm range-anchor selection remains a compatibility reader, not a second acquisition owner.

## Checks and counts

All logs below are under `.project/tmp/FIX-HOME-PREVIEW/`.

- **Constructed RED:** real Home row regression: 2 intended failures before production edits (`red.log`): available remote preview text never appeared.
- **GREEN, current Home:** 7/7 (`home-green.log`); cold result 1 read at `limit=1,beforeSeq=5`; large inventory 2 visible rows → 2 reads at `limit=1`; 0 read-state writes from preview acquisition.
- **GREEN, reader acquisition:** 3/3 (`green-final2.log`); cold secondary-Home acquisition has 0 additional inventory requests and 0 full-transcript consumers; receipt push updates add 0 HTTP reads.
- **GREEN, warm reader + result selection:** 6/6 (`green-final.log`, the two passing files); **adjacent demand:** 3/3 (`demand-adjacent.log`). Total: 19 distinct tests across 5 files.
- **AUTO entry loads:** 7/7, terminal exit 0 (`entry-loads-final.log`): daemon preparation, daemon, CLI, voice worker, server, UI catalog, SDK browser.
- Initial GREEN exposed a missing plaintext mode flag, corrected at the pipeline call. Subsequent test setup failures involved bootstrap inventory accounting, an absent full carrier in the cold fixture, and applying receipt-only push expectations to ambient previews. They were corrected without adding production subscriptions or fetches. The Home harness retains its existing unrelated bootstrap 404 warnings; the separate real network reader test measures the no-inventory delta.
- UI typecheck initially did not launch without a baseline, then rejected the mixed historical inventory. The recorded `.project/tmp/systemic-orch/ui-1104b.locs` was normalized to 708 extant UI diagnostic locations in `baseline.locs`; the public touched runner remains pending. No zero-delta or package-GREEN claim.
- The existing compiler run stays alive and was not cancelled or re-pinned. A read-only controller observation showed 32 active dispatches and 2 queued followers; no stall diagnosis is inferred. The later integration owner must obtain terminal diagnostics and reconcile the nine source/test paths in the source commit (including the extracted result selector) against that wave's recorded baseline.
- Scoped `git diff --check` passed. No documentation contract changed: this corrects acquisition for the existing preview; no wire/persistence schema, setting or public API changed.

## Mechanism delta and self-review

- Checks **+4 / −0**: existing viewport eligibility controls demand; exact acquisition must be available; an already-loaded reply avoids a read; a final assistant anchor supplies the one-row request. These are acquisition decisions at existing owners, not duplicated authorization checks.
- States, error codes, timers, retries, caches, queues and feature gates: **+0 / −0**. One optional Turn id extends the existing demand identity so a new completion can enter demand on the same Session.
- Production files **+1 / −0**, 5 existing files modified; tests **+0 / −0**, 3 existing files modified. The adapter exists to use the shared message pipeline without adding Home-specific transcript machinery to the sync engine.
- Self-review removed the measurement wrapper in favor of the existing pressable ref and extracted Turn identity selection instead of copying it. No competing preview fetcher, inventory scan, polling or full-transcript preview path was introduced.

## Commit, reload and residual risk

- Source: `fe51526a3e04d96f9fb71cdf5c41663452d265e7`, private index and same-HEAD compare-and-swap; shared index untouched; no push.
- **Reload:** full UI / Expo browser JavaScript reload to load the new hook and browser sync engine. No server, daemon or native binary restart is needed.
- **Loaded replay pending:** FINAL-QA should reload its existing `agent-qa-l12-d2` UI, return cold to Home without opening `cmw58kofk002omcyk79ltge05`, and confirm its preview plus the other visible rows; scroll an offscreen row into view and retain the empty/unavailable control. This lane did not commandeer the other lane's mutable stack/browser.
- The targeted preview projection requires an authoritative final assistant anchor, just like the existing Turn navigation projection. Missing anchors, unreadable content and genuinely empty responses retain unavailable behavior; opening still uses the full transcript path. Range-only warm compatibility selection is unchanged. Browser/device geometry and the loaded R29 fix remain unverified until the named replay; no visual acceptance is claimed.
