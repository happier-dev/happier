import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPurposeDeclarationV1 } from '@happier-dev/protocol';

import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import {
    createPluginInvocationHostPolicyResolver,
    createPluginResourceAccountStorageResolver,
    createTargetActionHostBindingResolver,
    projectConnectedAccountPurposeDeclarationsToHostAccess,
} from './resolve';

const action = Object.freeze({
    qualifiedId: 'acme.alpha/actions/run',
    pluginId: 'acme.alpha',
    localId: 'run',
    occurrenceId: '7',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'acme-alpha-root' },
    dangerLevel: 'safe',
    scopes: Object.freeze(['global']),
    surfaces: Object.freeze(['cli']),
    hostAccess: Object.freeze([]),
    input: Object.freeze({}),
    policyFingerprint: 'a'.repeat(64),
});

describe('invocation HostAccess metadata', () => {
    it('routes Connected Account purpose references without treating optional declarations as grants', () => {
        const resolve = createPluginInvocationHostPolicyResolver({
            createServiceBinding: createPluginInvocationServiceBinding,
        });
        const policy = resolve(action, { surface: 'cli', hostAccessRequests: [{
            required: true,
            request: { id: 'terminal', capability: 'terminal', reason: 'Native runtime use',
                scope: { operations: ['open', 'send'] } },
        }, {
            required: false,
            request: {
                id: 'primary', capability: 'connectedAccounts', reason: 'Use the selected Account',
                scope: { serviceRefs: ['local-account', { pluginId: 'acme.accounts', localId: 'shared-account' }],
                    operations: ['select', 'use'], materializationKinds: ['environment'] },
            },
        }] });
        expect(policy.hostAccess).toEqual([]);
        expect(policy.serviceBinding.connectedAccountScopes).toEqual([{
            purpose: 'primary',
            serviceRefs: [
                { pluginId: action.pluginId, localId: 'local-account' },
                { pluginId: 'acme.accounts', localId: 'shared-account' },
            ],
            operations: ['select', 'use'],
            materializationKinds: ['environment'],
        }]);
    });

    it('does not predict service availability or refuse a declared capability before construction', async () => {
        const resolve = createTargetActionHostBindingResolver();
        const result = await resolve(action, { surface: 'background', executionRealm: 'background-service-process',
            hostAccessRequests: [{ required: true, request: {
                id: 'terminal', capability: 'terminal', reason: 'Native runtime use',
                scope: { operations: ['open', 'send'] },
            } }],
        });
        expect(result?.action.hostAccess).toEqual([]);
        expect(result?.serviceBinding.occurrenceId).toBe(action.occurrenceId);
        expect(result?.serviceBinding.connectedAccountScopes).toBeUndefined();
    });

    it('preserves long-lived contribution purpose identities', () => {
        const declarations: ConnectedAccountPurposeDeclarationV1[] = [{
            purpose: 'primary', service: 'local-account', materializationKinds: ['files'],
        }, {
            purpose: 'fallback', service: { pluginId: 'acme.accounts', localId: 'shared-account' }, required: false,
        }];
        const requests = projectConnectedAccountPurposeDeclarationsToHostAccess(declarations);
        expect(requests.map(({ request }) => ({ id: request.id, capability: request.capability, scope: request.scope })))
            .toEqual([{
                id: 'primary', capability: 'connectedAccounts',
                scope: { serviceRefs: ['local-account'], operations: ['select', 'use'], materializationKinds: ['files'] },
            }, {
                id: 'fallback', capability: 'connectedAccounts',
                scope: { serviceRefs: [{ pluginId: 'acme.accounts', localId: 'shared-account' }], operations: ['select', 'use'] },
            }]);
    });

    it('returns typed unavailability when a required Resource Account host is absent', () => {
        const resolve = createPluginResourceAccountStorageResolver({});
        expect(() => resolve({
            pluginId: action.pluginId, resourceId: 'live', occurrenceId: action.occurrenceId,
            hostAccessRequests: [{ required: true, request: {
                id: 'account-storage', capability: 'storage.account', reason: 'Persist Account state', scope: { enabled: true },
            } }],
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        })).toThrow(expect.objectContaining({ code: 'plugin_account_storage_unavailable' }));
    });

    it('refuses a stale source occurrence before invoking its services', async () => {
        const resolve = createTargetActionHostBindingResolver({ isOccurrenceCurrent: async () => false });
        await expect(resolve(action, { hostAccessRequests: [], surface: 'cli' }))
            .rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });
});
