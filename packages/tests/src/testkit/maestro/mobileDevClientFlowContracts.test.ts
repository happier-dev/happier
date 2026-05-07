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
  it('dismisses system and Expo overlays before attempting shared bootstrap connection flows', () => {
    const connectIfNeededFlow = readFileSync(sharedFlowUrls[0], 'utf8');
    expect(connectIfNeededFlow).toContain('file: dismissAndroidSystemNotRespondingDialogMaybe.yaml');
    expect(connectIfNeededFlow).toContain('file: dismissDeveloperMenuMaybe.yaml');
    expect(connectIfNeededFlow).toContain('file: dismissExpoDevMenuOverlayMaybe.yaml');

    const launchUrlFlow = readFileSync(sharedFlowUrls[1], 'utf8');
    expect(launchUrlFlow).toContain('file: acceptAndroidOpenWithPromptMaybe.yaml');
    expect(launchUrlFlow).toContain('file: dismissDeveloperMenuMaybe.yaml');
    expect(launchUrlFlow).toContain('file: dismissExpoDevMenuOverlayMaybe.yaml');
  });

  it('prefers the launch-url bootstrap path before falling back to manual entry', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');
    expect(flow.indexOf('file: connectUsingLaunchUrl.yaml')).toBeGreaterThanOrEqual(0);
    expect(flow.indexOf('file: connectUsingManualEntry.yaml')).toBeGreaterThan(
      flow.indexOf('file: connectUsingLaunchUrl.yaml'),
    );
  });

  it('rewrites the manual-entry Metro field from the env-provided URL before submit', () => {
    const flow = readFileSync(manualEntryFlowUrl, 'utf8');
    const inputTapIndex = flow.indexOf('tapOn: "(http://localhost:8081|exp://)"');
    const clipboardIndex = flow.indexOf('setClipboard: ${HAPPIER_E2E_DEV_CLIENT_METRO_URL}');
    const pasteIndex = flow.indexOf('pasteText');

    expect(inputTapIndex).toBeGreaterThanOrEqual(0);
    expect(flow).not.toContain('tapOn: "http://localhost:8081"');
    expect(clipboardIndex).toBeGreaterThan(inputTapIndex);
    expect(clipboardIndex).toBeGreaterThan(flow.indexOf('eraseText'));
    expect(pasteIndex).toBeGreaterThan(clipboardIndex);
    expect(flow.indexOf('hideKeyboard')).toBeGreaterThan(pasteIndex);
  });

  it('retries the launch-url bootstrap path before the manual-entry fallback wait', () => {
    const flow = readFileSync(sharedFlowUrls[0], 'utf8');
    const retryLaunchIndex = flow.lastIndexOf('file: connectUsingLaunchUrl.yaml');
    const manualFallbackWaitIndex = flow.lastIndexOf(
      'visible: "(Login with mobile app|Create account|What would you like to work on\\\\?|Hi! How can I help you today\\\\?|Sessions|Start a session from your computer)"',
    );

    expect(retryLaunchIndex).toBeGreaterThan(flow.indexOf('visible: "Reload"'));
    expect(manualFallbackWaitIndex).toBeGreaterThan(retryLaunchIndex);
  });

  it('keeps overlay dismissal resilient with both close-first and back fallback branches', () => {
    const flow = readFileSync(expoDevMenuOverlayFlowUrl, 'utf8');

    expect(flow.match(/tapOn:\s*"Close"/g)).toHaveLength(1);
    expect(flow.match(/-\s+back/g)).toHaveLength(2);
    expect(flow.indexOf('tapOn: "Close"')).toBeGreaterThan(flow.indexOf('when:\n            visible: "Close"'));
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

  it('restores populated relay accounts from an environment-provided secret beyond the original 64-character limit', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');

    const firstChunkIndex = flow.indexOf('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_01}');
    const ninthChunkIndex = flow.indexOf('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_09}');

    expect(firstChunkIndex).toBeGreaterThan(flow.indexOf('id: restore-manual-secret-input'));
    expect(ninthChunkIndex).toBeGreaterThan(firstChunkIndex);
    expect(flow).not.toContain('setClipboard: ${HAPPIER_E2E_RESTORE_KEY}');
    expect(flow).not.toContain('pasteText');
    expect(flow).toContain('id: restore-manual-submit');
    expect(ninthChunkIndex).toBeLessThan(flow.indexOf('id: "session-list-item-.*"'));
  });

  it('clears Expo overlays after populated relay server selection before restore', () => {
    const flow = readFileSync(populatedRelayRestoreAndOpenUrl, 'utf8');
    const serverSelectionIndex = flow.indexOf(':///settings/server?auto=1');
    const overlayDismissIndex = flow.indexOf('file: _shared/dismissExpoDevMenuOverlayMaybe.yaml', serverSelectionIndex);
    const restoreIndex = flow.indexOf(':///restore/manual');

    expect(serverSelectionIndex).toBeGreaterThanOrEqual(0);
    expect(overlayDismissIndex).toBeGreaterThan(serverSelectionIndex);
    expect(overlayDismissIndex).toBeLessThan(restoreIndex);
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
