import { describe, it } from 'vitest';

/**
 * The producer half of BRW-F9: browser automation and recording driven by a REAL managed
 * Chrome-for-Testing sidecar. Both cases are unimplemented, and this file exists so that gap stays
 * visible in the tier where the work belongs rather than living only in a ledger line.
 *
 * WHY THEY DO NOT RUN (re-derived 2026-08-23; the previously recorded blocker was wrong).
 *
 * The recorded blocker was "no managed Chrome sidecar exists". That is false. The sidecar source is
 * complete and fail-closed by design:
 *   - `packages/protocol/src/browser/sidecar/chromiumForTesting.ts` pins Chrome-for-Testing
 *     127.0.6533.88 with a real `integrityDigest` for all four supported platforms.
 *   - `apps/cli/src/packagedRuntime/installables/sourceAdapters/chromiumForTesting.ts` is a
 *     complete digest-verified installer that unpacks to `<happyHomeDir>/tools/browser-chromium`.
 *   - `apps/cli/src/daemon/browser/sidecar/source.ts` maps that install into the one
 *     provenance-bearing `managedBrowserPackage` candidate the product gate consumes.
 *
 * The real reasons, each one falsifiable:
 *   1. NO DAEMON BROWSER ROUTES AT RUNTIME (the decisive one; not a test problem).
 *      `startDaemonSessionControlRuntime.ts:2089` declares `resolveBrowserUseAllowed?:` and `:8815`
 *      reads `params.resolveBrowserUseAllowed?.() === true`. Grepped 2026-08-23: the ONLY callers
 *      passing it are inside `startDaemonSessionControlRuntime.test.ts`. In production it is
 *      `undefined`, so the guarded block never runs — and that block holds the sole
 *      `browserControlBroker.registerAdapter(...)` call site (`:8826`) and the only assignments of
 *      `browserControlRoutes` / `browserContextRoutes` / `browserAutomationRoutes`. A
 *      `browser.automation.*` or `browser.recording.*` dispatch therefore has no daemon route to
 *      reach on current `dev`. Owned by lane A1 of the RU2 Surfaces Finalization plan; until it
 *      lands, running these cases would fail for this reason and a Chrome-shaped diagnosis would be
 *      a misattribution.
 *   2. NOT PROVISIONED. Nothing installs the artifact for a test run. `~/.happier/tools/
 *      browser-chromium` is absent on the development host and on CI runners, so
 *      `resolveInstalledChromiumForTestingExecutable` returns `null` and the resolver reports
 *      `managed_package_missing`. Provisioning it means a ~150 MB third-party download from
 *      `storage.googleapis.com` on every `e2e-core-slow` run — a hermeticity and cost decision that
 *      belongs to whoever owns the CI budget, not to a test author.
 *   3. NO PRODUCER HARNESS. Beyond the binary there is no test harness that launches the sidecar,
 *      attaches CDP, serves a fixture page, and drives the daemon browser runtime. Writing one is
 *      the actual work item; it is not blocked by the binary.
 *
 * WHAT WOULD MAKE THEM RUNNABLE: daemon browser routes actually constructed at startup, an installed
 * digest-verified Chrome-for-Testing artifact, and a sidecar-launching harness. When all three exist,
 * replace these placeholders with the real dispatches — do not weaken them into another in-process
 * test. The in-process dispatch and agent-egress redaction path is already covered, honestly, by
 * `suites/core-layer/browserRuntimeActionDispatchEgress.layer.test.ts`.
 *
 * NOTE ON `recording/`: the recording tree is LIVE, not unbuilt — real routes, service, artifact
 * store and a desktop reverse-capture producer. Only the CDP-screencast limb is dormant, which is
 * exactly the limb the second case below would exercise.
 */

describe('core e2e: browser automation and recording through a real managed Chrome sidecar', () => {
  it.skip('navigates, clicks, types, and snapshots through real browser automation producers', () => {
    // Unimplemented: requires an installed managed Chrome-for-Testing artifact and a
    // sidecar-launching harness. Assert `snapshot.interactiveElements[].selector` is producer
    // output, not fixture input.
  });

  it.skip('records to an artifact using browser.recording.start/stop against a live sidecar', () => {
    // Unimplemented: requires the same prerequisites plus a Chromium/CDP screencast-capable
    // sidecar. Assert the finalized recording artifact exists on disk.
  });
});
