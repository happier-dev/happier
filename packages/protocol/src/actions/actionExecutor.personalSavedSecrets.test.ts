import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createPersonalSavedSecretActionExecuteV1 } from '../account/settings/personalSavedSecretActionsV1.js';
import { formatSharedSavedSecretRefV1, listAccountSettingsSavedSecretReferences } from '../account/settings/savedSecretMutationOwner.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '../providers/connections/connectionRowsV1.js';

describe('personal Saved Secret Action boundary', () => {
  it('describes one secret with its value-free census and leaves ordinary lists census-free', async () => {
    const requested: string[] = [];
    const references = [{ owner: 'provider' as const, path: 'diagnostic-only',
      referrer: { kind: 'provider' as const, id: 'pc_northwind', displayName: 'Northwind models' } }];
    const providerConnections = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [{ v: 1, id: 'pc_northwind', source: { kind: 'contribution', contributionKey: 'happier.provider.fixture/default' },
        role: 'default', displayName: 'Northwind models', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }],
      secretBindingsByConnectionId: { pc_northwind: { account: { apiKey: formatSharedSavedSecretRefV1('one') }, byMachineId: {} } },
    });
    const execute = createPersonalSavedSecretActionExecuteV1({
      list: async () => [{ secretId: 'one', name: 'Key', kind: 'apiKey', revision: 1 },
        { secretId: 'other', name: 'Other', kind: 'token', revision: 2 }],
      usedBy: async secretId => {
        requested.push(secretId);
        return listAccountSettingsSavedSecretReferences({}, formatSharedSavedSecretRefV1(secretId), { profileRecords: [], providerConnections });
      },
      create: async () => ({ secretId: 'unused', secretRef: 'unused' }),
      update: async () => ({ revision: 2 }), delete: async () => { throw new Error('read must not delete'); },
    });
    await expect(execute('secrets.list', {})).resolves.toMatchObject({ secrets: [{ secretId: 'one' }, { secretId: 'other' }] });
    expect(requested).toEqual([]);
    await expect(execute('secrets.list', { secretId: 'one' })).resolves.toEqual({
      secrets: [{ secretId: 'one', name: 'Key', kind: 'apiKey', updatedAt: 1 }], usedBy: [{ ...references[0],
        path: 'providerConnectionsCatalog.secretBindingsByConnectionId.pc_northwind.account.apiKey' }],
    });
    expect(requested).toEqual(['one']);
  });
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
