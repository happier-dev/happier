import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';

describe('approval field presentation', () => {
  it.each([
    ['ordered members', ['account-b', 'account-a']],
    ['an explicit empty list', []],
  ])('preserves %s as structured JSON rather than flattening or hiding the mutation', (_label, accountIds) => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.pools.reorder',
      actionArgs: {
        group: { serviceId: 'service-a', groupId: 'pool-a' },
        accountIds,
        expectedGeneration: '1',
      },
    });

    expect(presentation.rows).toContainEqual(expect.objectContaining({
      kind: 'value', path: 'accountIds', value: JSON.stringify(accountIds),
    }));
    expect(presentation.unrepresentable).toBeNull();
  });

  it('treats required input withheld by live-only custody as present without disclosing it', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'notifications.webhooks.signingSecret.set',
      actionArgs: {
        channelId: 'webhook-a',
        secret: 'recognizable-live-only-secret',
      },
    });

    expect(presentation).toEqual({
      rows: [
        { kind: 'value', path: 'channelId', title: 'Webhook id', value: 'webhook-a' },
      ],
      unrepresentable: null,
    });
    expect(JSON.stringify(presentation)).not.toContain('recognizable-live-only-secret');
  });

  it('applies live-only withholding to non-secret structured configuration fields', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.configuration.replace',
      actionArgs: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai' },
        modeId: 'configured',
        expectedRevision: 'before',
        values: { endpoint: 'https://private-endpoint.test' },
        secretValues: { token: 'recognizable-private-replacement' },
      },
    });

    expect(presentation.unrepresentable).toBeNull();
    expect(JSON.stringify(presentation)).not.toContain('private-endpoint');
    expect(JSON.stringify(presentation)).not.toContain('private-replacement');
  });
});
