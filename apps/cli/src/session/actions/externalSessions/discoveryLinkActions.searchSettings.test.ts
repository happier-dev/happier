import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('standard conversation search settings admission', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await createTempDir('happier-standard-search-settings-');
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    vi.resetModules();
  });
  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    await removeTempDir(homeDir);
  });

  it('refuses content search with an explicit settings reason before touching native sources', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, conversationSearch: { standardSearch: { enabled: false } } });
    const { executeExternalSessionCandidatesListAction } = await import('./discoveryLinkActions');
    // No Agent installation or authentication is needed to observe this Machine's off choice.
    const result = await executeExternalSessionCandidatesListAction({
      machineId: 'machine-1', agentId: 'claude', source: { kind: 'claudeConfig' },
      searchTarget: 'content', searchTerm: 'needle',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.parse(result)).toEqual({
      ok: true, candidates: [], nextCursor: null, contentCoverage: 'unsupported',
      contentCoverageReason: 'standard_search_disabled',
    });
  });
});
