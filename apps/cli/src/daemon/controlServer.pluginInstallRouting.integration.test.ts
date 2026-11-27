import { afterEach, expect, it, vi } from 'vitest';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './externalActions/executeExternalAction.filesystemApprovals.testkit';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFilesystemApprovalSocketBoundary();
  resetServerFeaturesClientForTests();
});

it('executes a signed global plugin install at the receiving daemon without re-entering delivery or reading a Session', async () => {
  const actionId = 'plugins.install';
  const h = await createHarness(actionId, 'allowed');
  try {
    const result = await h.runRootControl({ path: 'happier-plugin-qa-capabilities', kind: 'npm', dryRun: true }, actionId);
    expect(result, JSON.stringify({ result, paths: h.networkPaths })).toMatchObject({ ok: true, result: {
      ok: true, kind: 'plugins_install', dryRun: true,
      request: { kind: 'installNpm', packageName: 'happier-plugin-qa-capabilities' },
    } });
    const delivery = `POST /v1/actions/${actionId}`;
    const admission = `${delivery}/execution-authorization`;
    expect(h.networkPaths.filter(path => path === admission || path === delivery)).toEqual([admission, delivery]);
    expect(h.networkPaths.some(path => path.startsWith('GET /v2/sessions/'))).toBe(false);
  } finally { await h.close(); }
});
