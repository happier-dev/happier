import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol';
import { createActionExecutor, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions';

import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

// Sign-in storage is an OS boundary; the real host Action service requires a captured Account.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
    readStoredCredentials: async () => ({ token: 'machine-services-fixture', encryption: null }),
}));

describe('bundled Machine Services Action admission', () => {
    it('loads and executes health/setup for a Home-admitted Account request', async () => {
        const pluginId = 'happier.machine.services';
        const machineId = 'machine-services-account';
        const serverId = 'srv_machine_services';
        const target = { kind: 'machine' as const, machineId };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: 'home-admitted-account-request', binding: {
                serverIdentityId: serverId, accountId: 'account-services', custodianAccountId: 'account-services',
                installationId: 'installation-services', machineId, actionId: 'action.invoke', requestId: 'health-setup-request',
                requestEnvelopeDigest: 'A'.repeat(43), authentication: { kind: 'account', tokenEpoch: 1 }, target,
            },
        });
        const keys = tweetnacl.sign.keyPair();
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [pluginId],
            accountStorageDependencies: { readCredentials: async () => null },
            resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        } });
        try {
            const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => ({
                ...fixture.lease, release: async () => {},
            }) });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: invoke });
            const sourceConfig = { v: 1, subject: { kind: 'machineService', machineId, serviceId: 'web' }, checks: [{
                checkId: 'web-http', kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
                config: { endpoint: 'http://127.0.0.1:8080', expectStatus: 200 }, periodMs: 60_000,
                consecutiveFailuresBeforeAlerting: 1,
            }] };
            expect(fixture.registry.contributes.actionsById.has(`${pluginId}/health/setup`)).toBe(true);
            const result = await executor.execute('action.invoke', {
                action: { pluginId, localId: 'health/setup' }, input: sourceConfig,
            }, {
                surface: 'api', authority: 'present_user', serverId, serverIdentityId: serverId,
                runtimeAccountId: 'account-services', actionRequestId: 'health-setup-request', actionCaller: { kind: 'host' },
                externalActionExecutionAuthorization: authorization, externalActionTarget: target,
                signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ ...request,
                    authorizationToken: authorization.token, privateKey: keys.secretKey,
                }),
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { v: 1, sourceContractVersion: 1, sourceConfig } });
            expect(fixture.registry.targetActionInvocations.has(pluginId, 'health/setup')).toBe(true);
        } finally {
            await fixture.dispose();
        }
    });
});
