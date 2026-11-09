import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';

import { logger } from '@/utils/logger';
import { observeConnectedServiceMaterializationPhase, observeCurrentConnectedServiceMaterializationPhase } from './materializationPhase';

afterEach(() => vi.restoreAllMocks());

it.each(['completed', 'failed'] as const)('retires the diagnostic context of a %s operation for inherited async work', async status => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const run = { agentId: 'codex', materializationKey: 'run-binding' };
  let wake!: () => void;
  const ready = new Promise<void>(resolve => { wake = resolve; });
  let later!: Promise<void>;
  const failure = new Error('fixture failure');
  const operation = observeConnectedServiceMaterializationPhase(run, 'credential_binding_resolution', async () => {
    later = ready.then(async () => {
      await observeCurrentConnectedServiceMaterializationPhase('established_credential_read', async () => undefined);
      // An independently observed later operation owns its new root, even when
      // it uses the same retained Run key for an explicit recovery.
      await observeConnectedServiceMaterializationPhase(run, 'credential_binding_resolution', async () => {
        await observeCurrentConnectedServiceMaterializationPhase('established_credential_read', async () => undefined);
      });
    });
    if (status === 'failed') throw failure;
  });
  if (status === 'failed') await expect(operation).rejects.toBe(failure);
  else await operation;
  log.mockClear();
  wake();
  await later;
  const rows = log.mock.calls.map(([, fields]) => fields);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({ phase: 'credential_binding_resolution', status: 'started' });
  expect(rows[0]).not.toHaveProperty('parentPhaseId');
  expect(rows[1]).toMatchObject({ phase: 'established_credential_read', status: 'started' });
});

it('attributes nested credential work to its declared service without recording account material', async () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const service = { pluginId: 'example.agent', localId: 'subscription', accountId: 'private-account' };
  await observeConnectedServiceMaterializationPhase({
    agentId: 'claude', materializationKey: 'service-attribution', service,
  }, 'native_home_credentials', async () => {
    await observeCurrentConnectedServiceMaterializationPhase('established_credential_read', async () => 'private-token');
  });
  const rows = log.mock.calls.map(([, fields]) => fields);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row).toMatchObject({ service: { pluginId: service.pluginId, localId: service.localId } });
  }
  expect(JSON.stringify(rows)).not.toMatch(/private-account|accountId|private-token/);
});

it('correlates overlapping materializations and settles failed children without logging their payload', async () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const first = { agentId: 'claude', materializationKey: 'first' };
  const second = { agentId: 'claude', materializationKey: 'second' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('secret-credential-in-error');
  const blocked = observeConnectedServiceMaterializationPhase(first, 'group_selection', async () => {
    await observeCurrentConnectedServiceMaterializationPhase('group_lease_wait', () => pending);
    return await observeConnectedServiceMaterializationPhase(first, 'group_generation_apply', async () => { throw failure; });
  });
  await observeConnectedServiceMaterializationPhase(second, 'group_selection', async () => {
    await observeConnectedServiceMaterializationPhase(second, 'group_state_read', async () => 'secret-result');
  });
  time = 75;
  release();
  await expect(blocked).rejects.toBe(failure);
  // File logging is an untyped system boundary; inspect only its record payloads.
  const rows = log.mock.calls.flatMap(([, fields]) => fields && typeof fields === 'object'
    ? [fields as Record<string, unknown>] : []);
  for (const context of [first, second]) {
    const outer = rows.find(row => row.materializationKey === context.materializationKey
      && row.phase === 'group_selection' && row.status === 'started')!;
    const child = rows.find(row => row.materializationKey === context.materializationKey
      && row.phase === (context === first ? 'group_generation_apply' : 'group_state_read') && row.status === 'started')!;
    expect(child.parentPhaseId).toBe(outer.phaseId);
    expect(outer.parentPhaseId).toBeUndefined();
    const status = context === first ? 'failed' : 'completed';
    expect(rows).toContainEqual(expect.objectContaining({ phaseId: child.phaseId, status }));
    expect(rows).toContainEqual(expect.objectContaining({ phaseId: outer.phaseId, status,
      durationMs: context === first ? 75 : 0 }));
  }
  const lease = rows.find(row => row.phase === 'group_lease_wait' && row.status === 'started')!;
  const waitingSelection = rows.find(row => row.materializationKey === first.materializationKey
    && row.phase === 'group_selection' && row.status === 'started')!;
  expect(lease.parentPhaseId).toBe(waitingSelection.phaseId);
  expect(rows).toContainEqual(expect.objectContaining({ phase: 'group_lease_wait', phaseId: lease.phaseId,
    status: 'completed', durationMs: 75 }));
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['agentId', 'materializationKey', 'phase', 'phaseId', 'status', 'durationMs',
      ...(row.parentPhaseId ? ['parentPhaseId'] : [])].sort());
  }
  expect(JSON.stringify(rows)).not.toMatch(/secret-|Error|stack|token/);
  log.mockClear();
  await expect(observeCurrentConnectedServiceMaterializationPhase('credential_read', async () => 'unobserved-result'))
    .resolves.toBe('unobserved-result');
  await expect(observeCurrentConnectedServiceMaterializationPhase('credential_read', () => { throw failure; }))
    .rejects.toBe(failure);
  expect(log).not.toHaveBeenCalled();
});
