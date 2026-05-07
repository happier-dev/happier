import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const installedAppPerformanceSmokeUrl = new URL(
  '../../../suites/mobile-e2e/flows/F12.installedAppPopulatedRelaySessionPerformanceSmoke.yaml',
  import.meta.url,
);
const installedAppRestoreAndOpenUrl = new URL(
  '../../../suites/mobile-e2e/flows/F13.installedAppPopulatedRelayRestoreAndOpenSessionPerformance.yaml',
  import.meta.url,
);

function readFlow(url: URL): string {
  expect(existsSync(url.pathname)).toBe(true);
  return readFileSync(url, 'utf8');
}

describe('mobile installed-app populated relay flow contracts', () => {
  it('validates populated relay session opening without Expo Dev Client bootstrap', () => {
    const flow = readFlow(installedAppPerformanceSmokeUrl);

    expect(flow).not.toContain('connectUsingLaunchUrl');
    expect(flow).not.toContain('connectDevClientIfNeeded');
    expect(flow.match(/acceptAndroidOpenWithPromptMaybe/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(flow).toContain('id: "session-list-item-.*"');
    expect(flow).toContain('id: "(transcript-chat-list|session-empty-messages)"');
  });

  it('restores populated relay accounts without Expo Dev Client bootstrap beyond the original 64-character limit', () => {
    const flow = readFlow(installedAppRestoreAndOpenUrl);
    const serverSelectionIndex = flow.indexOf(':///settings/server?auto=1');
    const serverUrlWaitIndex = flow.indexOf('visible: ".*${HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN}.*"', serverSelectionIndex);
    const restoreIndex = flow.indexOf(':///restore/manual');

    expect(flow).not.toContain('connectUsingLaunchUrl');
    expect(flow).not.toContain('connectDevClientIfNeeded');
    expect(flow).toContain(':///settings/server?auto=1');
    expect(serverUrlWaitIndex).toBeGreaterThan(serverSelectionIndex);
    expect(serverUrlWaitIndex).toBeLessThan(restoreIndex);
    expect(flow).toContain('id: restore-manual-secret-input');
    expect(flow).toContain('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_09}');
    expect(flow).toContain('id: "session-cockpit-tabbar-.*"');
  });
});
