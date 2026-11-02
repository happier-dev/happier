import { afterEach, expect, it, vi } from 'vitest';
import { HomeConnectionDescriptorV1Schema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol';
import { executeScmActionOperation } from './executeScmActionOperation';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

it('reads saved SCM evidence for its canonical Home and refuses a foreign Home', async () => {
  await withTempDir('happier-scm-review-home-', async cwd => {
    vi.stubEnv('HAPPIER_HOME_DIR', cwd);
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'local-profile');
    reloadConfiguration();
    const url = 'https://scm.example.test';
    await updateSettings(current => ({ ...current, servers: { ...current.servers, 'local-profile': {
      id: 'local-profile', name: 'SCM', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_scm_home',
        canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }),
    }, 'foreign-profile': {
      id: 'foreign-profile', name: 'Foreign', serverUrl: 'https://foreign.example.test', webappUrl: 'https://foreign.example.test',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_foreign',
        canonicalServerUrl: 'https://foreign.example.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://foreign.example.test' }] }),
    } } }));
    const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, summaryMarkdown: 'Retained Home evidence', sourceKey: 'home-review',
      metadata: { source: { kind: 'workingTree' }, sourceKey: 'home-review' },
      comparison: { id: 'home-review', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
        inventory: { state: 'complete', files: [], reasons: [] } },
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Saved Home evidence', intro: '', stops: [], otherChangeRefs: [] } } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'owner-session', output });
    const base = { actionId: 'scm.diffSummary.result.read' as const, input: { cwd, resultId: saved.resultId },
      workingDirectory: cwd, sessionId: 'owner-session', accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] },
      authorizeSession: async (id: string | undefined) => id === 'owner-session' };
    const denied = await executeScmActionOperation({ ...base, actionContext: { serverId: 'srv_foreign' } });
    expect(denied).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(denied).not.toHaveProperty('result');
    expect(await executeScmActionOperation({ ...base, actionContext: { serverId: 'srv_scm_home' } }))
      .toMatchObject({ success: true, result: { resultId: saved.resultId, output: { summaryMarkdown: 'Retained Home evidence' } } });
    expect(await executeScmActionOperation({ ...base, authorizeSession: async () => false,
      actionContext: { serverId: 'srv_scm_home' } })).toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });
});
