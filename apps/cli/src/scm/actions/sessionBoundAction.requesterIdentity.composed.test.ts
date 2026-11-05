import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';

// Observe the genuine OS boundary while allowing the actual Git processes and
// canonical Exec supervision to run. No SCM or identity owner is substituted.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());

it('refuses an admitted shared-Machine Use SCM request before launching as the daemon owner', async () => {
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-scm-member-' });
    const machineId = 'shared-machine';
    const installationId = 'shared-installation';
    const home = 'shared-home';
    const registration = createGitScmBackendRuntimeRegistration();
    // This is the installed daemon policy port, without any selected member
    // launch identity. Disabled optional isolation cannot grant owner execution
    // to another Account admitted with Use access.
    const runner = createHostScmCommandRunner({ isCurrent: () => true, agentIsolation: {
        read: () => ({ enabled: false, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
    } });
    const backend = createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
        executableDefinition: registration.runtime!, registration, scmCommandRunner: runner,
    });
    const manager = createRpcHandlerManager({ scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
        encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId, resolveCustodianAccountId: async () => 'owner-account', resolveInstallationId: () => installationId,
            resolveHomeServerIdentityId: async () => home,
            // Authentication/currentness are the Home network boundary. The
            // receiving authorizer and requester identity selection stay real.
            verifyMachineAdmission: async () => true,
        }),
    });
    registerScmHandlers(manager, repository.rootPath, { machineId,
        accessPolicy: { kind: 'restrictedRoots', roots: [repository.rootPath] }, registry: createScmBackendRegistry([backend]) });
    const target = { kind: 'machine' as const, machineId, project: { machineId, directory: repository.rootPath } };
    const actionInput = { cwd: repository.rootPath };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'member-scm-read', target, input: actionInput });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-member', binding: {
        accountId: 'member-account', custodianAccountId: 'owner-account', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: home, actionId: 'scm.status.snapshot', requestId: envelope.requestId,
        machineId, installationId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner-account' })).toString('base64url')}.signature`, encryption: null };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: '', mode: 'plain', ctx: null, serverId: home, serverIdentityId: home,
        externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: new Uint8Array(32),
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        machineActionDirectTargetTransport: { machineId, invoke: (method, input, options) => manager.invokeLocal(method, input, options) },
    }));
    vi.mocked(spawn).mockClear();
    try {
        const ownerEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'owner-scm-read', target, input: actionInput });
        const ownerAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
            token: 'home-admitted-owner', binding: { ...authorization.binding, accountId: 'owner-account',
                requestId: ownerEnvelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ownerEnvelope) },
        });
        const ownerResponse = await executor.execute('scm.status.snapshot', actionInput, {
            surface: 'rpc', authority: 'present_user', actionCaller: { kind: 'host' },
            actionRequestId: ownerEnvelope.requestId, runtimeAccountId: 'owner-account', serverId: home, serverIdentityId: home,
            machineAdmission: { actorAccountId: 'owner-account', custodianAccountId: 'owner-account', machineId,
                installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
            externalActionExecutionAuthorization: ownerAuthorization, externalActionTarget: target,
        });
        const ownerLaunches = vi.mocked(spawn).mock.calls.map(([, , options]) => ({
            uid: options?.uid ?? process.getuid?.(), gid: options?.gid ?? process.getgid?.(),
        }));
        expect(ownerResponse).toMatchObject({ ok: true });
        expect(ownerLaunches.length).toBeGreaterThan(0);
        expect(ownerLaunches.every(launch => launch.uid === process.getuid?.() && launch.gid === process.getgid?.())).toBe(true);
        vi.mocked(spawn).mockClear();
        const response = await executor.execute('scm.status.snapshot', actionInput, {
            surface: 'rpc', authority: 'present_user', actionCaller: { kind: 'host' },
            actionRequestId: envelope.requestId, runtimeAccountId: 'member-account', serverId: home, serverIdentityId: home,
            machineAdmission: { actorAccountId: 'member-account', custodianAccountId: 'owner-account', machineId,
                installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
            externalActionExecutionAuthorization: authorization, externalActionTarget: target,
        });
        // There is no member native identity in this fixture. A process here
        // would inherit the daemon's OS user even if the SCM read succeeds.
        const launches = vi.mocked(spawn).mock.calls.map(([command, , options]) => ({ command,
            uid: options?.uid ?? process.getuid?.(), gid: options?.gid ?? process.getgid?.() }));
        expect(launches).toEqual([]);
        expect(response).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
    } finally {
        await removeTempDir(repository.rootPath);
    }
});
