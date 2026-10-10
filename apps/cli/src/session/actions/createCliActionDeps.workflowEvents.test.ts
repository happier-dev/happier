import { describe, expect, it } from 'vitest';
import { ActionIdSchema, createActionExecutor } from '@happier-dev/protocol';

import { createCliActionDeps } from './createCliActionDeps';

const event = {
  event: {
    id: 'acme.events/repository/updated',
    identity: { pluginId: 'acme.events', localId: 'repository/updated' },
    occurrenceId: 'event-generation-a',
    sourceCustody: { kind: 'development', registeredRootId: 'events-root' },
    title: 'Repository updated', description: null,
    payloadSchema: { type: 'object', additionalProperties: false },
    automation: { v: 1, eligible: true, source: {
      sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
      sourceConfigSchema: { type: 'object', additionalProperties: false },
      setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
    } },
  },
  setupAction: {
    id: 'acme.events/configure-source',
    identity: { pluginId: 'acme.events', localId: 'configure-source' },
    occurrenceId: 'event-generation-a', title: 'Configure source', description: null,
    inputSchema: { type: 'object', additionalProperties: false }, inputHints: null,
  },
} as const;

function executorFor(read: NonNullable<Parameters<typeof createCliActionDeps>[0]['machineActionDirectTargetTransport']>['invoke']) {
  return createActionExecutor(createCliActionDeps({
    token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test',
    machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: read },
  }));
}

describe('workflow eligible Event catalog through Actions', () => {
  it('reads the addressed daemon projection, including source capability and setup facts', async () => {
    const requests: Array<{ method: string; request: unknown; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const executor = executorFor(async (method, request, options) => {
      requests.push({ method, request, signal: options?.signal });
      return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} },
        automationEligibleEvents: [event] };
    });
    await expect(executor.execute(ActionIdSchema.parse('workflow.events.list'), { machineId: 'machine-1' },
      { surface: 'mcp', authority: 'account_automation', signal })).resolves.toEqual({
      ok: true, result: { machineId: 'machine-1', events: [event] },
    });
    expect(requests).toEqual([{ method: 'daemon.extensions.contributionRegistryProjection.describe', signal,
      request: { machineId: 'machine-1' } }]);
  });

  it('distinguishes an empty supported catalog from missing eligibility support and invalid occurrence facts', async () => {
    const projection = { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} } };
    const actionId = ActionIdSchema.parse('workflow.events.list');
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    await expect(executorFor(async () => ({ ...projection, automationEligibleEvents: [] }))
      .execute(actionId, { machineId: 'machine-1' }, context)).resolves.toEqual({
      ok: true, result: { machineId: 'machine-1', events: [] },
    });
    for (const response of [projection, { ...projection, automationEligibleEvents: [{ ...event,
      setupAction: { ...event.setupAction, occurrenceId: 'retired-occurrence' } }] }]) {
      await expect(executorFor(async () => response).execute(actionId, { machineId: 'machine-1' }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'workflow_event_catalog_unavailable' });
    }
  });

  it('refuses a different Home and disabled Action before reading the Machine', async () => {
    let invoked = false;
    const executor = executorFor(async () => { invoked = true; return {}; });
    const actionId = ActionIdSchema.parse('workflow.events.list');
    await expect(executor.execute(actionId, { machineId: 'machine-1', serverId: 'home-2' },
      { surface: 'cli', authority: 'account_automation' })).resolves.toMatchObject({
      ok: false, errorCode: 'server_scope_mismatch',
    });
    const disabled = createActionExecutor({
      isActionEnabled: () => false,
    });
    await expect(disabled.execute(actionId, { machineId: 'machine-1' }, { surface: 'agent' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(invoked).toBe(false);
  });

  it('rejects private source and plugin-caller selectors instead of materializing a source', async () => {
    let invoked = false;
    const executor = executorFor(async () => { invoked = true; return {}; });
    await expect(executor.execute(ActionIdSchema.parse('workflow.events.list'), {
      machineId: 'machine-1', pluginId: 'acme.events', sourceInstanceId: 'configured-source',
    }, { surface: 'agent' })).resolves.toMatchObject({ ok: false });
    expect(invoked).toBe(false);
  });
});
