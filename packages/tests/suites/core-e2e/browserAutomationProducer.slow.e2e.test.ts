import { describe, it } from 'vitest';

/**
 * Real managed Chrome producer coverage remains unimplemented (BRW-F9 / E1(3)).
 *
 * Prerequisites rechecked 2026-11-14 (FIX-REVIEW-B-1114): production startup now
 * constructs createBrowserRuntimeActionExecutor in apps/cli/src/daemon/startDaemon.ts;
 * the former resolveBrowserUseAllowed startup seam is no longer a blocker.
 *
 * This core-e2e suite has no fixture that provisions a digest-verified managed
 * Chrome-for-Testing install, launches it through daemon startup, serves a page,
 * and attaches the real automation/recording consumer. The controller's default
 * ~/.happier/tools/browser-chromium install is also absent; other hosts and CI
 * were not probed, so this is not a claim that their installs are missing.
 *
 * To unskip: supply that managed-artifact/daemon-startup fixture and run the two
 * journeys below. No download or CI provisioning is performed by these skips.
 * The injected dispatch coverage in core-layer/browserRuntimeActionDispatchEgress.layer.test.ts
 * is useful adjacent coverage, but does not replace either real producer journey.
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
