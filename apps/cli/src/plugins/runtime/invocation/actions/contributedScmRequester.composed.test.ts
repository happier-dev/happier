import { rm } from 'node:fs/promises';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { reloadConfiguration } from '@/configuration';
import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { runWithRealGitScmRuntime } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { executeContributedAction } from './executeContributedAction';

const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
const credentials = { token, encryption: null };

// The installed Machine's persisted credentials are an OS boundary. They are
// deliberately present even when the invocation has no admitted requester.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => credentials }));

it.each([
    { source: 'admitted', comparison: false },
    { source: 'absent', comparison: false },
    { source: 'foreign-installation', comparison: false },
    { source: 'admitted', comparison: true },
    { source: 'absent', comparison: true },
    { source: 'foreign-account', comparison: true },
] as const)(
    'runs a reviewed contributed Action with $source requester custody through the installed SCM receiver (comparison: $comparison)',
    async ({ source, comparison }) => runWithRealGitScmRuntime(async () => {
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-contributed-scm-' });
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        env.patch({ HAPPIER_HOME_DIR: repository.rootPath, HAPPIER_ACTIVE_SERVER_ID: 'home' });
        reloadConfiguration();
        const homeAdmission = vi.fn(async () => false);
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveHomeServerIdentityId: async () => 'home',
                resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: homeAdmission,
            }),
        });
        const filesystem = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
        });
        registerScmHandlers(rpc, repository.rootPath, { machineId: 'machine', registry: createTestGitScmBackendRegistry(),
            selectWorkspaceSource: filesystem.selectWorkspaceSource, admitWorkspaceSource: filesystem.rpc,
            resolveRequester: filesystem.resolveRpcRequester,
        });
        const plugin = definePlugin({ id: 'test.contributed-scm-requester', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: { prepare: {
                title: 'Prepare review', surfaces: ['cli'], dangerLevel: 'safe',
                inputSchema: { type: 'object', additionalProperties: false }, resultSchema: { type: 'object' },
                run: async (_input, context) => comparison
                    ? context.services.actions.execute('scm.diffSummary.capture', {
                        cwd: repository.rootPath, projection: { kind: 'index' }, source: { kind: 'pullRequest', locator: {
                            providerId: 'example-forge', repository: 'example/reviews-fixture', number: 1,
                            baseOid: repository.headCommit, headOid: repository.headCommit,
                        } },
                    })
                    : context.services.actions.execute('scm.file.read', {
                        cwd: repository.rootPath, path: repository.trackedPath, selector: { commit: repository.headCommit },
                    }),
            } },
        });
        const action = { pluginId: plugin.manifest.id, localId: 'prepare' };
        // Home HTTP owns Account currentness and the Machine observed by SCM.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            } };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/machines/machine') return { status: 200, data: { machine: {
                id: 'machine', kind: 'persistent', active: true, installationId: 'installation',
                managedMachineRef: null, revokedAt: null, replacedByMachineId: null,
                metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage',
                    resourceMode: 'plain', accessState: 'ready' },
            } } };
            throw new Error(`Unexpected Home read: ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
            if (availability) return availability;
            throw new Error(`Unexpected Home request: ${new URL(String(url)).pathname}`);
        });
        let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            await updateMachineRegistration(() => ({ machineId: 'machine' }));
            fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                happyHomeDir: repository.rootPath,
                controller: pluginReloadController,
                runtimeOptions: { resolveCurrentMachineId: () => 'machine',
                    scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
                    machineActionDirectTargetTransport: { machineId: 'machine', invoke: rpc.invokeLocal.bind(rpc) },
                },
                plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                    instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            });
            const target = { kind: 'machine', machineId: 'machine' } as const;
            const installationId = source === 'foreign-installation' ? 'another-installation' : 'installation';
            const requesterAccountId = source === 'foreign-account' ? 'other-account' : 'owner';
            const context: RpcActionExecutorContext = { surface: 'cli', authority: 'account_automation', externalActionTarget: target,
                ...(source !== 'absent' ? {
                    authenticatedLocalRootCustody: { serverIdentityId: 'home', accountId: requesterAccountId, machineId: target.machineId, installationId },
                    requesterWorkAttributionV1: { serverId: 'home', accountId: requesterAccountId, machineId: target.machineId, installationId },
                } : {}),
            };
            const result = await executeContributedAction({ runtimeRegistry: fixture.registry,
                actionId: `${action.pluginId}/${action.localId}`, input: {},
                approvalContext: { ...context, hostReviewedChild: createHostReviewedChildPortV1({
                    actionId: 'action.invoke', input: { action, input: {} }, context, reviewAdmitted: true,
                }) },
                context: { surface: 'cli', invocationSurface: 'cli' },
            });
            if (source === 'admitted') {
                expect(result, JSON.stringify(result)).toMatchObject({ matched: true, result: { ok: true, result: comparison
                    ? { success: true, comparison: { source: { kind: 'pullRequest' }, repository: { rootPath: repository.rootPath } } }
                    : { success: true, contentBase64: Buffer.from('base\n').toString('base64') },
                } });
                if (comparison && result.matched && result.result.ok) {
                    expect(ScmComparisonCaptureOutputSchema.safeParse(result.result.result).success).toBe(true);
                }
            } else if (source === 'absent') {
                expect(result).toMatchObject({ matched: true, result: { ok: false, errorCode: 'agent_isolation_unavailable',
                    data: { failureCause: { phase: 'rpc.admission.local_requester_unavailable' } },
                } });
            } else {
                expect(result).toMatchObject({ matched: true, result: { ok: false, errorCode: 'RPC_FORBIDDEN' } });
            }
            expect(homeAdmission).not.toHaveBeenCalled();
        } finally {
            await fixture?.dispose();
            env.restore();
            reloadConfiguration();
            await rm(repository.rootPath, { recursive: true, force: true });
            vi.restoreAllMocks();
        }
    }),
);
