import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { captureConnectedAccountInvocationPurposeBinding, createConnectedAccountPurposePort, type ConnectedAccountInvocationPurposeBinding } from './purposeBinding.js';

const service = { pluginId: 'acme.cloud', localId: 'cloud-account' };
const purpose = { consumer: { pluginId: 'acme.compute', localId: 'create' }, purpose: 'cloud-api' };
const account = { service, accountId: 'selected' };
const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [
  { id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [
    { id: 'token', title: 'Token', secret: true, schema: { type: 'string', minLength: 1 } },
  ] },
] });
const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, authenticationModeId: 'token',
  status: 'connected', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
  configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Cloud', scopes: [] });

describe('Account purpose selection through the shared Credentials owner', () => {
  it('captures the exact invocation receiver and launch binding without admitting a foreign consumer', () => {
    let current = true;
    let managedCurrent = true;
    const input = {
      identity: { pluginId: ' acme.compute ', localId: ' create ' }, operationId: ' launch-1 ',
      purposes: [purpose], purposeBindings: { v: 1 as const, bindings: [{ purpose, target: {
        kind: 'account' as const, account: { service: { ...service }, accountId: account.accountId },
      } }] },
      isCurrent: () => current,
      managedOperation: { role: 'acquire' as const, isCurrent: () => managedCurrent,
        credentialConfigurations: [{ account, revision: null }] },
    } satisfies ConnectedAccountInvocationPurposeBinding;
    const captured = captureConnectedAccountInvocationPurposeBinding(input, purpose.consumer);
    expect(captured.identity).toEqual(purpose.consumer);
    expect(captured.operationId).toBe('launch-1');
    expect(captured.managedOperation?.credentialConfigurations).toEqual([{ account, revision: null }]);
    expect(captured.isCurrent()).toBe(true);
    input.purposeBindings.bindings[0]!.target.account.accountId = 'changed-default';
    expect(captured.purposeBindings.bindings[0]?.target).toEqual({ kind: 'account', account });
    managedCurrent = false;
    expect(captured.isCurrent()).toBe(false);
    managedCurrent = true;
    current = false;
    expect(captured.isCurrent()).toBe(false);
    expect(() => captureConnectedAccountInvocationPurposeBinding(input, { ...purpose.consumer, localId: 'another-action' }))
      .toThrow('managed_provider_operation_authority_consumer_mismatch');
    expect(() => captureConnectedAccountInvocationPurposeBinding({ ...input, purposes: [purpose, purpose] }))
      .toThrow('managed_provider_operation_authority_duplicate_purpose');
    expect(() => captureConnectedAccountInvocationPurposeBinding({ ...input, purposes: [] }))
      .toThrow('managed_provider_operation_authority_binding_invalid');
  });

  it('refuses a selected Account that differs from the admitted launch binding', async () => {
    const port = createConnectedAccountPurposePort({ available: true,
      resolveService: async () => ({ service, authentication }), listAccounts: async () => [profile],
      materializeAccount: async () => { throw new Error('Unadmitted material acquisition'); },
    });
    await expect(port.bind({ purpose, serviceRefs: [service],
      expectedAccount: { service, accountId: 'not-selected' },
      purposeBindings: { v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
  });

  it('acquires listed material once without postread metadata or configuration acquisitions', async () => {
    let materialized = false;
    let acquisitions = 0;
    let postreadMetadata = 0;
    let postreadConfiguration = 0;
    let metadataReads = 0;
    let configurationReads = 0;
    // Metadata transport and credential/configuration custody are physical host ports.
    const port = createConnectedAccountPurposePort({ available: true,
      resolveService: async () => ({ service, authentication }),
      listAccounts: async () => { metadataReads++; if (materialized) postreadMetadata++; return [profile]; },
      resolveConnectedAccountEndpoints: async () => { configurationReads++; if (materialized) postreadConfiguration++; return []; },
      materializeAccount: async () => { acquisitions++; materialized = true; return { kind: 'httpHeaders' as const, headers: {} }; },
    });
    const binding = await port.bind({ purpose, serviceRefs: [service],
      purposeBindings: { v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] },
      signal: new AbortController().signal });
    await expect(binding.materializeListedAccount(account, { kind: 'httpHeaders', origin: 'https://cloud.example.test',
      headerNames: ['authorization'] })).resolves.toEqual({ kind: 'httpHeaders', headers: {} });
    expect(acquisitions).toBe(1);
    expect(postreadMetadata).toBe(0);
    expect(postreadConfiguration).toBe(0);
    expect(metadataReads).toBe(1);
    expect(configurationReads).toBe(1);
  });

  it('distinguishes an absent selection from an unavailable selected target without acquiring material', async () => {
    const port = createConnectedAccountPurposePort({ available: false,
      resolveService: async () => ({ service, authentication }), listAccounts: async () => [profile],
      materializeAccount: async () => { throw new Error('Unadmitted material acquisition'); },
    });
    const input = { purpose, serviceRefs: [service], signal: new AbortController().signal };
    await expect(port.bind({ ...input, purposeBindings: { v: 1, bindings: [] } }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'unselected' } });
    await expect(port.bind({ ...input, purposeBindings: { v: 1,
      bindings: [{ purpose, target: { kind: 'account', account } }] } }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'target_unavailable' } });
  });

  it('lists each selectable Account once without opening keys and refuses an unauthorized service', async () => {
    const port = createConnectedAccountPurposePort({ available: true,
      resolveService: async () => ({ service, authentication }),
      listAccounts: async () => [profile],
      materializeAccount: async () => { throw new Error('Metadata selection must not acquire credentials'); },
    });
    expect(await port.listActionFormConnectedAccountOptions({ serviceRefs: [service, service], signal: new AbortController().signal }))
      .toEqual([{ value: account, label: 'Cloud' }]);
    const selection = { purpose, serviceRefs: [service], purposeBindings: { v: 1 as const,
      bindings: [{ purpose, target: { kind: 'account' as const, account } }] }, signal: new AbortController().signal };
    await expect(port.bind({ ...selection, serviceRefs: [{ pluginId: 'other.cloud', localId: service.localId }] }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
  });
});
