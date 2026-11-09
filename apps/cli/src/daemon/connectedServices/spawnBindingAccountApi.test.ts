import { afterEach, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import axios from 'axios';

import { logger } from '@/utils/logger';
import { observeConnectedServiceMaterializationPhase } from './materialize/materializationPhase';
import { createSpawnBindingAccountApi } from './spawnBindingAccountApi';

afterEach(() => vi.restoreAllMocks());

const service = { pluginId: 'example.connected-accounts', localId: 'subscription' };
const context = { agentId: 'codex', materializationKey: 'binding-http-observation' };

it.each(['completed', 'failed'] as const)('subdivides %s metadata HTTP reads without recording their payload or changing their outcome', async status => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const failure = new Error('private-transport-detail');
  const reply = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [] });
  // The injected methods are the qualified Home HTTP boundary. Resolution,
  // observation and context correlation use their real internal owners.
  const api = createSpawnBindingAccountApi({ token: 'private-token', api: {
    readGroup: async () => { if (status === 'failed') throw failure; return null; },
    listAccounts: async () => { if (status === 'failed') throw failure; return reply; },
  } });
  await observeConnectedServiceMaterializationPhase(context, 'credential_binding_resolution', async () => {
    const group = api.readGroup({ service, groupId: 'private-pool' });
    if (status === 'failed') await expect(group).rejects.toBe(failure);
    else await expect(group).resolves.toBeNull();
    const accounts = api.listAccounts({ service });
    if (status === 'failed') await expect(accounts).rejects.toBe(failure);
    else await expect(accounts).resolves.toBe(reply);
  });
  const rows = log.mock.calls.flatMap(([marker, row]) => marker === '[CONNECTED ACCOUNT] Materialization phase'
    && row && typeof row === 'object' ? [row as Record<string, unknown>] : []);
  const root = rows.find(row => row.phase === 'credential_binding_resolution' && row.status === 'started');
  for (const phase of ['binding_group_read', 'binding_account_list']) {
    const starts = rows.filter(row => row.phase === phase && row.status === 'started');
    expect(starts, phase).toHaveLength(1);
    expect(starts[0]).toMatchObject({ parentPhaseId: root?.phaseId });
    expect(rows).toContainEqual(expect.objectContaining({ phase, phaseId: starts[0]?.phaseId,
      parentPhaseId: root?.phaseId, status, durationMs: expect.any(Number) }));
  }
  expect(JSON.stringify(rows)).not.toMatch(/private-|accounts|Error|stack|token/);
});

it('observes fresh Account metadata after revocation without adding reads or emitting outside a materialization', async () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  let reads = 0;
  let revoked = false;
  // Real qualified HTTP client and response parsing; only the network is stubbed.
  const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      reads++;
      return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: 'private-account' }, status: revoked ? 'needs_reauth' : 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
        configurationRevision: null, scopes: [],
      }] }) };
  });
  const api = createSpawnBindingAccountApi({ token: 'private-token' });
  const controller = new AbortController();
  expect((await api.listAccounts({ service })).accounts[0]?.status).toBe('connected');
  revoked = true;
  expect((await api.listAccounts({ service, signal: controller.signal })).accounts[0]?.status).toBe('needs_reauth');
  expect(reads).toBe(2);
  expect(get.mock.calls[1]?.[1]).toMatchObject({ signal: controller.signal });
  expect(log).not.toHaveBeenCalled();
});
