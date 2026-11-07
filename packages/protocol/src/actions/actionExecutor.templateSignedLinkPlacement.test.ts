import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { clientActionUnavailable, UiActionDispatchRequestV1Schema } from './clientDispatchV1.js';

const release = { draftArtifactId: '11111111-1111-4111-8111-111111111111',
  expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '' };
const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true,
  actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) } as const;

describe('reviewed template release placement', () => {
  it.each([undefined, 'selected-client'] as const)('routes signed-link release to its answering client (%s)', async clientId => {
    const received: unknown[] = [];
    // The answering UI is a separate process; keep admission and its public carrier real.
    const executor = createActionExecutor({ clientActionExecute: async invocation => {
      const wire = UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: invocation.actionId,
        input: invocation.input, context: { surface: invocation.context.surface, authority: invocation.context.authority } });
      received.push(wire);
      return clientActionUnavailable(wire.actionId);
    } });
    const input = { ...release, share: { recipients: [], signedInLink: true }, ...(clientId ? { clientId } : {}) };
    expect(await executor.execute('template.release', input, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(received).toEqual([expect.objectContaining({ actionId: 'template.release', input })]);
  });

  it('keeps ordinary release on the account owner when no signed link needs private client delivery', async () => {
    let clientDeliveries = 0;
    const executor = createActionExecutor({ clientActionExecute: async invocation => {
      clientDeliveries++;
      return clientActionUnavailable(invocation.actionId);
    } });
    expect(await executor.execute('template.release', release, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(clientDeliveries).toBe(0);
  });
});
