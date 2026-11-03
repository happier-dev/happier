import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createPersonalSavedSecretActionExecuteV1 } from '../account/settings/personalSavedSecretActionsV1.js';

describe('personal Saved Secret Action boundary', () => {
  it('admits one metadata browse, bulk link, and export operation while keeping Store-in private', async () => {
    const target = { contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'account', vaultId: 'vault' };
    expect(getActionSpec('secrets.create').inputSchema.safeParse({ name: 'Token', value: 'private-test-value', storeIn: target }).success).toBe(true);
    expect(getActionSpec('secrets.create').inputSchema.safeParse({ name: 'Token', source: { kind: 'external', ...target, reference: 'op://v/i/f' }, storeIn: target }).success).toBe(false);
    expect(getActionSpec('secrets.list').inputSchema.safeParse({ source: target }).success).toBe(true);
    expect(getActionSpec('secrets.link').inputSchema.safeParse({ source: target, itemIds: ['item-a', 'item-b'] }).success).toBe(true);
    expect(getActionSpec('secrets.export').inputSchema.safeParse({ target, secrets: [{ secretId: 'one', expectedUpdatedAt: 1 }] }).success).toBe(true);
    const result = await createPersonalSavedSecretActionExecuteV1({ list: async () => [], create: async () => ({ secretId: 'unused', secretRef: 'unused' }),
      update: async () => ({ revision: 2 }), delete: async () => {} })('secrets.link', { source: target });
    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(JSON.stringify(getActionSpec('secrets.create').projectObservationInput?.({ name: 'Token', value: 'private-test-value', storeIn: target }))).not.toContain('private-test-value');
  });
  it('links and updates external sources through the existing private mutation port', async () => {
    const source = { kind: 'external' as const, contribution: { pluginId: 'acme.vault', localId: 'vault' },
      account: 'my-account', reference: 'op://vault/item/token' };
    const writes: unknown[] = [];
    const execute = createPersonalSavedSecretActionExecuteV1({ list: async () => [],
      create: async input => { writes.push(input); return { secretId: 'linked', secretRef: 'saved-secret-resource:linked' }; },
      update: async input => { writes.push(input); return { revision: 2 }; }, delete: async () => {} });
    await expect(execute('secrets.create', { name: 'Vault token', source })).resolves.toMatchObject({ secretId: 'linked' });
    await expect(execute('secrets.update', { secretId: 'linked', expectedUpdatedAt: 1, source: { ...source, reference: 'op://vault/item/rotated' } }))
      .resolves.toEqual({ secretId: 'linked', updatedAt: 2 });
    expect(writes).toEqual([{ name: 'Vault token', source }, { secretId: 'linked', expectedUpdatedAt: 1,
      source: { ...source, reference: 'op://vault/item/rotated' } }]);
    expect(getActionSpec('secrets.create').inputSchema.safeParse({ name: 'ambiguous', source, value: 'copied' }).success).toBe(false);
  });
  it('keeps plaintext in live input custody and reuses exact UI confirmation while automated writes require approval', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
    for (const id of ['secrets.create', 'secrets.update', 'secrets.delete'] as const) {
      const spec = getActionSpec(id);
      const input = id === 'secrets.create' ? { name: 'Private token', value: 'private-test-value' }
        : id === 'secrets.update' ? { secretId: 'resource-id', value: 'private-test-value', expectedUpdatedAt: 1 }
          : { secretId: 'resource-id', expectedUpdatedAt: 1 };
      expect(spec.safety).toBe('danger');
      expect(resolveActionApprovalRouting({ actionId: id, spec, settings,
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(id === 'secrets.delete');
      for (const surface of ['ui', 'agent', 'cli', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId: id, spec, settings,
          context: { surface, authority: 'present_user', actionCaller: { kind: 'host' },
            ...(surface === 'ui' ? { presentUserConfirmation: { actionId: id } } : {}) } }).required).toBe(surface !== 'ui');
      }
      if (id !== 'secrets.delete') {
        expect(spec.approvalInputCustody).toBe('live_only');
        expect(JSON.stringify(spec.projectObservationInput?.(input))).not.toContain('private-test-value');
      }
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
    }
    expect(getActionSpec('secrets.list').outputSchema?.safeParse({ secrets: [{ secretId: 'resource-id',
      name: 'Private token', kind: 'token', updatedAt: 1, value: 'must never be listed' }] }).success).toBe(false);
  });
});
