import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';

describe('approval field presentation', () => {
  it.each(['account', 'team', 'group'])('keeps %s access principals as data, not Session references', (kind) => {
    const principal = { kind, ...(kind === 'group' ? { teamId: 'team-1' } : {}), [`${kind}Id`]: 'session-shaped-id' };
    const rows = describeApprovalActionFields({ actionId: 'machines.access.grant.set',
      actionArgs: { serverId: 'home', machineId: 'machine', principal, level: 'view' } }).rows;
    expect(rows.find(row => row.path === 'principal')).toMatchObject({ kind: 'value', path: 'principal', value: JSON.stringify(principal) });
    expect(rows.find(row => row.path === 'principal')).not.toHaveProperty('reference');
  });

  it('identifies the declared Voice Session target with its own Home', () => {
    const rows = describeApprovalActionFields({ actionId: 'ui.voice_global.start', actionArgs: {
      target: { kind: 'session', sessionAddress: { serverId: 'other-home', sessionId: 'session-1' } }, expectedAttempt: null,
    } }).rows;
    expect(rows.find(row => row.path === 'target')).toMatchObject({
      reference: { kind: 'session', id: 'session-1', serverId: 'other-home' },
    });
  });

  it('does not interpret an arbitrary configuration object as a typed target', () => {
    const value = { kind: 'session', sessionId: 'session-1', empty: '', absent: null };
    const rows = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value } }).rows;
    expect(rows.find(row => row.path === 'value')).toMatchObject({ value: JSON.stringify(value) });
    expect(rows.find(row => row.path === 'value')).not.toHaveProperty('reference');
  });
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
