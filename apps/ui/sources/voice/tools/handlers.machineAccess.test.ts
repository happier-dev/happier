import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createVoiceToolHandlers } from './handlers';

describe('Voice Machine access Action effect', () => {
  it('executes the advertised grant tool with the captured Home policy and no physical authority input', async () => {
    const settings = { experiments: true, featureToggles: { voice: true }, actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.grant.set': ['voice'] },
    } };
    const home = await serveActionHomes({ homes: [
      { key: 'machine', serverUrl: 'https://voice-machine-access.test', accountId: 'alice', settings },
      { key: 'focused', serverUrl: 'https://voice-machine-focused.test', accountId: 'cara' },
    ], route: request => request.home === 'machine' && request.path === '/v1/machines/machine/access'
      && request.method === 'PUT' ? Response.json({ kind: 'saved', grant: { machineId: 'machine',
        principal: { kind: 'account', accountId: 'bob' }, level: 'view' }, readiness: 'ready' }) : undefined });
    const previousSettings = storage.getState().settings;
    storage.setState({ settings: settingsParse(settings) });
    try {
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      const toolName = getActionSpec('machines.access.grant.set').bindings?.voiceClientToolName;
      expect(toolName).toBeTruthy();
      const input = { serverId: home.homes.machine!.id, machineId: 'machine',
        principal: { kind: 'account', accountId: 'bob' }, level: 'view' };
      expect(JSON.parse(await handlers[toolName!]!(input, { serverId: input.serverId })))
        .toMatchObject({ ok: true, kind: 'saved', readiness: 'ready' });
      expect(JSON.parse(await handlers[toolName!]!({ ...input, recipientKeyEnvelopes: [] }, { serverId: input.serverId })))
        .toMatchObject({ ok: false });
      expect(home.requests.filter(request => request.path.endsWith('/access')).map(request => ({
        home: request.home, accountId: request.accountId, body: request.body,
      }))).toEqual([{ home: 'machine', accountId: 'alice', body: { principal: input.principal, level: 'view' } }]);
    } finally {
      storage.setState({ settings: previousSettings });
      home.dispose();
    }
  });
});
