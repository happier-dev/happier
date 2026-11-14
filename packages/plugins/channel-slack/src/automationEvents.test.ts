import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST, activate } from './manifest.js';

const pluginId = 'happier.channel.slack';
const setupId = 'automation/setup-channel-message-source-v1';
const admitId = 'slack/admit-automation-event';
const eventRef = { pluginId, localId: 'automation/channel-message-observed-v1' };
const credentialRef = { service: { pluginId, localId: 'slack-bot' }, accountId: 'slack-test' };
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const sourceInstanceId = 'slack:team:T1:app:A1:channel:C1';
const sourceConfig = { v: 1, teamId: 'T1', appId: 'A1', channelId: 'C1' };
const connection = { v: 1, connectionId: 'slack-1', authorityEpoch: 1, enabled: true, deletionState: 'none',
  requiresFullSharedMessageContent: false, providerConnectionKey: 'slack:team:T1:app:A1',
  providerConfigVersion: 1, providerConfig: identity, credentialRef };

function boundary(enabled = true) {
  const materialize = vi.fn(async () => ({ kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }));
  const request = vi.fn(async ({ url }: { url: string }) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const body = method === 'auth.test' ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
      : method === 'bots.info' ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
      : method === 'conversations.info' ? { ok: true, channel: { id: 'C1', name: 'deploys', is_im: false, is_mpim: false, is_private: false, is_archived: false } }
      : undefined;
    if (!body) throw new Error(`Unexpected Slack method ${method}`);
    return { status: 200, finalUrl: url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const execute = vi.fn(async () => ({ 'slack-1': { ...connection, enabled } }));
  const context = {
    plugin: { id: pluginId, version: '0.0.0' }, surface: 'ui',
    contribution: { id: setupId, qualifiedId: `${pluginId}/actions/${setupId}` }, invokedAtMs: 1,
    signal: new AbortController().signal,
    // Credentials, host Action transport and Slack HTTP are genuine external boundaries.
    services: { connectedAccounts: { materialize }, http: { request }, actions: { execute } } as unknown as PluginInvocationContext['services'],
  } satisfies PluginInvocationContext;
  return { context, execute, materialize, request };
}

describe('Slack Workflow Events', () => {
  it('exposes read-only source resolution on every interactive surface without confirmation', () => {
    const setup = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === setupId);
    expect(setup).toMatchObject({
      surfaces: expect.arrayContaining(['ui', 'plugin', 'agent', 'mcp', 'cli']), dangerLevel: 'safe', readOnly: true,
    });
    expect(setup?.confirmation).toBeUndefined();
  });
  it('resolves a registered UI setup Action to immutable source facts for the exact enabled Channels connection', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const b = boundary();
      await expect(kit.invokeAction(setupId, { credentialRef, channelId: 'C1' }, { surface: 'ui', services: b.context.services })).resolves.toEqual({
        v: 1, sourceInstanceId, sourceContractVersion: 1, sourceConfig, displayLabel: '#deploys',
      });
      expect(b.materialize).toHaveBeenCalledWith('slack-credentials', expect.anything(), expect.objectContaining({ expectedAccount: credentialRef }));
      const disabled = boundary(false);
      await expect(kit.invokeAction(setupId, { credentialRef, channelId: 'C1' }, { surface: 'ui', services: disabled.context.services }))
        .rejects.toMatchObject({ code: 'slack_automation_channels_connection_required' });
      expect(disabled.request.mock.calls.some(([input]) => input.url.includes('conversations.info'))).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('admits only current armed sources through SDK socket admission, then settles safely after disarm', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const admit = kit.registration('actions', admitId);
      expect(admit, 'Slack must consume frozen Channels Event obligations').toBeTypeOf('function');
      let armed = true;
      const admissions: unknown[] = [];
      const definition = { automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'slack-trigger', triggerRevision: 1,
        eventRef, sourceInstanceId, sourceContractVersion: 1, sourceConfig,
        sourceSelectorId: '3f5b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d91',
        observationTransport: { kind: 'socket', watcherMaterializationRef: { pluginId, machineId: 'machine-1', materializationId: 'slack-1' } },
        filter: null, maximumObservationAgeMs: null };
      const execute = vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') return { kind: 'page', revision: '1', nextCursor: null, definitions: armed ? [definition] : [] };
        if (actionId === 'automation.event.admit') { admissions.push(input); return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] }; }
        if (actionId === 'automation.event.source.status.report') return {};
        throw new Error(`Unexpected host Action ${actionId}`);
      });
      const base = boundary().context;
      const context = { ...base, surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.other', occurrenceId: 'core-1',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'core-1', installSource: 'npm' },
        contribution: { id: 'fixture', qualifiedId: 'happier.channels/actions/fixture' },
        materialization: { pluginId: 'happier.channels', machineId: 'machine-1', materializationId: 'core-1' } },
        services: { actions: { execute } } as unknown as PluginInvocationContext['services'],
      } satisfies PluginInvocationContext;
      const input = { connectionId: 'slack-1', candidate: { eventRef, sourceInstanceId, sourceContractVersion: 1,
        payload: { teamId: 'T1', channelId: 'C1', messageId: '1700000000.000001', text: 'ship' } },
        occurrenceId: 'slack:T1:channel:C1:message:1700000000.000001', occurredAt: 1700000000000, observationReceivedAt: 1700000000001, observedDelta: 1 };
      await expect(admit!(input, context)).resolves.toEqual({ kind: 'checkpointSafe' });
      expect(admissions).toHaveLength(1);
      expect(admissions[0]).toMatchObject({ eventRef, occurrenceId: input.occurrenceId, payload: input.candidate.payload,
        definitions: [{ automationId: definition.automationId, triggerId: 'slack-trigger', triggerRevision: 1 }] });
      armed = false;
      await expect(admit!(input, context)).resolves.toEqual({ kind: 'checkpointSafe' });
      expect(admissions).toHaveLength(1);
      await expect(admit!(input, { ...context, caller: undefined })).rejects.toMatchObject({ code: 'slack_channels_core_caller_required' });
    } finally { await kit.dispose(); }
  });
});
