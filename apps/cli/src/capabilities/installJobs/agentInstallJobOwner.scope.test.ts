import { expect, test } from 'vitest';
import { createAgentInstallJobOwner } from './agentInstallJobOwner';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

test('built-in jobs deduplicate and expose results only within their admitted Account', async () => {
  const owner = createAgentInstallJobOwner({ accountId: 'owner', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'fixture', runtimeSpec: { id: 'fixture', title: 'Fixture', binaryName: 'fixture',
      sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none',
      manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false } }] }) });
  const request = { agentId: 'fixture', intent: 'install', consent: { vendorRecipe: false } } as const;
  const catalog = { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } satisfies AcpCatalogSnapshotV1;
  try {
    const a = owner.start(request, { accountId: 'a', catalog });
    const b = owner.start(request, { accountId: 'b', catalog });
    expect(a.ok && b.ok && a.jobId !== b.jobId).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(owner.list('a')).toMatchObject({ ok: true, jobs: [{ jobId: a.jobId }] });
    expect(owner.list('b')).toMatchObject({ ok: true, jobs: [{ jobId: b.jobId }] });
    expect(owner.read({ jobId: a.jobId, cursor: 0 }, 'b')).toMatchObject({ ok: false, errorCode: 'job_not_found' });
    expect(await owner.cancel({ jobId: a.jobId }, 'b')).toMatchObject({ ok: false, errorCode: 'job_not_found' });
    expect(owner.read({ jobId: a.jobId, cursor: 0 })).toMatchObject({ ok: false, errorCode: 'job_not_found' });
    expect(await owner.read({ jobId: a.jobId, cursor: 0, waitForTerminal: true }, 'a')).toMatchObject({ ok: true, done: true });
  } finally { await owner.shutdown(); }
});
