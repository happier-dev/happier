import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sharedFlowUrls = [
  new URL('../../../suites/mobile-e2e/flows/_shared/connectDevClientIfNeeded.yaml', import.meta.url),
  new URL('../../../suites/mobile-e2e/flows/_shared/connectUsingLaunchUrl.yaml', import.meta.url),
];

const manualEntryFlowUrl = new URL(
  '../../../suites/mobile-e2e/flows/_shared/connectUsingManualEntry.yaml',
  import.meta.url,
);
const expoDevMenuOverlayFlowUrl = new URL(
  '../../../suites/mobile-e2e/flows/_shared/dismissExpoDevMenuOverlayMaybe.yaml',
  import.meta.url,
);
const mobileFlowsRootUrl = new URL('../../../suites/mobile-e2e/flows', import.meta.url);
const populatedRelayPerformanceSmokeUrl = new URL(
  '../../../suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
  import.meta.url,
);
const populatedRelayRestoreAndOpenUrl = new URL(
  '../../../suites/mobile-e2e/flows/F13.populatedRelayRestoreAndOpenSessionPerformance.yaml',
  import.meta.url,
);
const newSessionGuidanceNoMachineSmokeUrl = new URL(
  '../../../suites/mobile-e2e/flows/F3.newSessionGuidanceNoMachineSmoke.yaml',
  import.meta.url,
);

function listYamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listYamlFiles(path);
      }
      return entry.endsWith('.yaml') ? [path] : [];
    });
}

describe('mobile Dev Client flow contracts', () => {
  it('recognizes native Expo DevLauncher error screens as bootstrap states', () => {
    for (const flowUrl of sharedFlowUrls) {
      const flow = readFileSync(flowUrl, 'utf8');
      expect(flow).toContain('There was a problem loading the project');
      expect(flow).toContain('Go To Home');
    }
  });

  it('recognizes Expo developer-menu onboarding as a bootstrap state', () => {
    for (const flowUrl of sharedFlowUrls) {
      const flow = readFileSync(flowUrl, 'utf8');
      expect(flow).toContain('This is the developer menu');
      expect(flow).toContain('Continue');
    }
  });

  it('handles Android chooser prompts after Dev Client launcher deep links', () => {
    const flow = readFileSync(new URL('../../../suites/mobile-e2e/flows/_shared/connectUsingLaunchUrl.yaml', import.meta.url), 'utf8');
    const openLinkIndex = flow.indexOf('openLink: ${HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL}');
    const firstChooserTextIndex = flow.indexOf('Open with .*', openLinkIndex);
    const firstChooserFlowIndex = flow.indexOf('file: acceptAndroidOpenWithPromptMaybe.yaml', openLinkIndex);
    const secondChooserTextIndex = flow.indexOf('Open with .*', firstChooserFlowIndex + 1);
    const secondChooserFlowIndex = flow.indexOf('file: acceptAndroidOpenWithPromptMaybe.yaml', firstChooserFlowIndex + 1);

    expect(openLinkIndex).toBeGreaterThanOrEqual(0);
    expect(firstChooserTextIndex).toBeGreaterThan(openLinkIndex);
    expect(firstChooserFlowIndex).toBeGreaterThan(firstChooserTextIndex);
    expect(secondChooserTextIndex).toBeGreaterThan(firstChooserFlowIndex);
    expect(secondChooserFlowIndex).toBeGreaterThan(secondChooserTextIndex);
  });

  it('accepts Android chooser prompts after server configuration deep links', () => {
    const flow = readFileSync(new URL('../../../suites/mobile-e2e/flows/_shared/configureServerIfNeeded.yaml', import.meta.url), 'utf8');
    const openLinkIndex = flow.indexOf('openLink: ${HAPPIER_E2E_MOBILE_APP_SCHEME}:///settings/server?auto=1&url=${HAPPIER_E2E_SERVER_URL}');
    const chooserFlowIndex = flow.indexOf('file: acceptAndroidOpenWithPromptMaybe.yaml', openLinkIndex);
    const overlayDismissIndex = flow.indexOf('file: dismissAndroidSystemNotRespondingDialogMaybe.yaml', openLinkIndex);

    expect(openLinkIndex).toBeGreaterThanOrEqual(0);
    expect(chooserFlowIndex).toBeGreaterThan(openLinkIndex);
    expect(chooserFlowIndex).toBeLessThan(overlayDismissIndex);
  });

  it('configures the per-run server even when welcome auth actions are already visible', () => {
    const flow = readFileSync(new URL('../../../suites/mobile-e2e/flows/_shared/configureServerIfNeeded.yaml', import.meta.url), 'utf8');
    const openLinkIndex = flow.indexOf('openLink: ${HAPPIER_E2E_MOBILE_APP_SCHEME}:///settings/server?auto=1&url=${HAPPIER_E2E_SERVER_URL}');
    const welcomeCreateAccountGuardIndex = flow.indexOf('notVisible:\n        id: welcome-create-account');

    expect(openLinkIndex).toBeGreaterThanOrEqual(0);
    expect(welcomeCreateAccountGuardIndex).toBe(-1);
  });

  it('recognizes developer-menu onboarding in the first Dev Client bootstrap waits', () => {
    const flow = readFileSync(new URL('../../../suites/mobile-e2e/flows/_shared/connectDevClientIfNeeded.yaml', import.meta.url), 'utf8');
    const waitLines = [...flow.matchAll(/visible: "([^"]+)"/g)].map((match) => match[1] ?? '');

    expect(waitLines[0]).toContain('This is the developer menu.*');
    expect(waitLines[0]).toContain('Continue');
    expect(waitLines[1]).toContain('This is the developer menu.*');
    expect(waitLines[1]).toContain('Continue');
  });

  it('dismisses the Happier brand prelude when it first appears after the Dev Client deep link', () => {
    const launchFlow = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/_shared/connectUsingLaunchUrl.yaml', import.meta.url),
      'utf8',
    );
    const bootstrapFlow = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/_shared/connectDevClientIfNeeded.yaml', import.meta.url),
      'utf8',
    );
    const launchIndex = bootstrapFlow.indexOf('file: connectUsingLaunchUrl.yaml');
    const postLaunchBrandStateIndex = bootstrapFlow.indexOf('Get started', launchIndex);
    const postLaunchBrandTapIndex = bootstrapFlow.indexOf('id: brand-hero-get-started', launchIndex);

    expect(launchFlow).toContain('Get started');
    expect(launchIndex).toBeGreaterThanOrEqual(0);
    expect(postLaunchBrandStateIndex).toBeGreaterThan(launchIndex);
    expect(postLaunchBrandTapIndex).toBeGreaterThan(postLaunchBrandStateIndex);
  });

  it('fails the bootstrap flow before app-specific waits when native DevLauncher load fails', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');
    expect(flow).toContain('assertNotVisible: "There was a problem loading the project"');
    expect(flow).toContain('assertNotVisible: "Go To Home"');
  });

  it('retries native DevLauncher timeout screens with the Reload affordance before failing fast', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');

    expect(flow).toContain('visible: "Reload"');
    expect(flow).toContain('tapOn: "Reload"');
  });

  it('opens the current Expo Dev Client manual-entry affordance before connecting', () => {
    const flow = readFileSync(manualEntryFlowUrl, 'utf8');

    expect(flow).toContain('visible: "Enter URL manually"');
    expect(flow).toContain('tapOn: "Enter URL manually"');
    expect(flow).toContain('tapOn: "(http://localhost:8081|exp://)"');

    for (const sharedFlowUrl of sharedFlowUrls) {
      expect(readFileSync(sharedFlowUrl, 'utf8')).toContain('Enter URL manually');
    }
  });

  it('does not fail overlay dismissal when the Expo close affordance is absent', () => {
    const flow = readFileSync(expoDevMenuOverlayFlowUrl, 'utf8');
    const closeGuardIndex = flow.indexOf('visible: "Close"');
    const closeTapIndex = flow.indexOf('tapOn: "Close"', closeGuardIndex);
    const fallbackGoHomeIndex = flow.indexOf('visible: "Go home"', closeTapIndex);

    expect(closeGuardIndex).toBeGreaterThanOrEqual(0);
    expect(closeTapIndex).toBeGreaterThan(closeGuardIndex);
    expect(fallbackGoHomeIndex).toBeGreaterThan(closeTapIndex);
    expect(flow).not.toContain('notVisible: "Close"');
    expect(flow).toContain('visible: "Tap something to inspect it"');
    expect((flow.match(/- back/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('dismisses a late Expo Dev Menu overlay before asserting new-session guidance', () => {
    const flow = readFileSync(newSessionGuidanceNoMachineSmokeUrl, 'utf8');
    const newSessionTapIndex = flow.indexOf('id: main-header-start-new-session');
    const overlayDismissIndex = flow.indexOf('file: _shared/dismissExpoDevMenuOverlayMaybe.yaml', newSessionTapIndex);
    const guidanceWaitIndex = flow.indexOf('id: setupWizard-machine-arrival-stack', newSessionTapIndex);

    expect(newSessionTapIndex).toBeGreaterThanOrEqual(0);
    expect(overlayDismissIndex).toBeGreaterThan(newSessionTapIndex);
    expect(guidanceWaitIndex).toBeGreaterThan(overlayDismissIndex);
    expect(flow).toContain('id: setupWizard-machine-arrival');
    expect(flow).toContain('id: setupWizard-machine-arrival-desktop-app-download-cta');
    expect(flow).not.toContain('session-getting-started-step-');
  });

  it('keeps runFlow file references resolvable relative to their owner flow', () => {
    const missingReferences: string[] = [];
    for (const flowPath of listYamlFiles(mobileFlowsRootUrl.pathname)) {
      const flow = readFileSync(flowPath, 'utf8');
      for (const match of flow.matchAll(/^\s*file:\s*([^#\n]+?)\s*$/gm)) {
        const referencedFile = match[1]?.trim();
        if (!referencedFile || referencedFile.includes('${')) continue;
        const target = join(dirname(flowPath), referencedFile);
        if (!existsSync(target)) {
          missingReferences.push(`${flowPath} -> ${referencedFile}`);
        }
      }
    }

    expect(missingReferences).toEqual([]);
  });

  it('waits for a stable transcript or empty-session surface after populated relay session open', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('id: "(transcript-chat-list|session-empty-messages)"');
  });

  it('returns to the session list before populated relay row selection', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('id: session-header-back');
    expect(flow.indexOf('id: session-header-back')).toBeLessThan(flow.indexOf('id: "session-list-item-.*"'));
  });

  it('force-loads the current Metro bundle before populated relay telemetry waits', () => {
    const flow = readFileSync(populatedRelayPerformanceSmokeUrl, 'utf8');

    expect(flow).toContain('file: _shared/connectUsingLaunchUrl.yaml');
    expect(flow.indexOf('file: _shared/connectUsingLaunchUrl.yaml')).toBeLessThan(
      flow.indexOf('file: _shared/connectDevClientIfNeeded.yaml'),
    );
  });

  it('restores populated relay accounts from an environment-provided secret before measuring', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');

    const firstChunkIndex = flow.indexOf('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_01}');
    const lastChunkIndex = flow.indexOf('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_08}');

    expect(firstChunkIndex).toBeGreaterThan(flow.indexOf('id: restore-manual-secret-input'));
    expect(lastChunkIndex).toBeGreaterThan(firstChunkIndex);
    expect(flow).not.toContain('setClipboard: ${HAPPIER_E2E_RESTORE_KEY}');
    expect(flow).not.toContain('pasteText');
    expect(flow).toContain('id: restore-manual-submit');
    expect(lastChunkIndex).toBeLessThan(flow.indexOf('id: "session-list-item-.*"'));
  });

  it('waits for the populated relay server URL before restoring', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');
    const serverSelectionIndex = flow.indexOf(':///settings/server?auto=1');
    const serverUrlWaitIndex = flow.indexOf('visible: ".*${HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN}.*"', serverSelectionIndex);
    const restoreIndex = flow.indexOf(':///restore/manual');

    expect(serverSelectionIndex).toBeGreaterThanOrEqual(0);
    expect(serverUrlWaitIndex).toBeGreaterThan(serverSelectionIndex);
    expect(serverUrlWaitIndex).toBeLessThan(restoreIndex);
  });

  it('accepts the Android app chooser after populated relay app-scheme deep links', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');
    const androidChooserFlow = 'file: _shared/acceptAndroidOpenWithPromptMaybe.yaml';

    const serverSelectionIndex = flow.indexOf(':///settings/server?auto=1');
    const serverChooserIndex = flow.indexOf(androidChooserFlow, serverSelectionIndex);
    const serverUrlWaitIndex = flow.indexOf(
      'visible: ".*${HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN}.*"',
      serverSelectionIndex,
    );

    const restoreIndex = flow.indexOf(':///restore/manual');
    const restoreChooserIndex = flow.indexOf(androidChooserFlow, restoreIndex);
    const restoreInputWaitIndex = flow.indexOf('id: restore-manual-secret-input', restoreIndex);

    expect(serverSelectionIndex).toBeGreaterThanOrEqual(0);
    expect(serverChooserIndex).toBeGreaterThan(serverSelectionIndex);
    expect(serverChooserIndex).toBeLessThan(serverUrlWaitIndex);
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(restoreChooserIndex).toBeGreaterThan(restoreIndex);
    expect(restoreChooserIndex).toBeLessThan(restoreInputWaitIndex);
  });

  it('accepts the current session cockpit surface after populated relay session open', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');

    expect(flow).toContain('id: "session-cockpit-tabbar-.*"');
  });
});
