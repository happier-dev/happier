import { rm } from 'node:fs/promises';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
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

it.each(['admitted', 'absent', 'foreign-installation'] as const)(
    'runs a reviewed contributed Action with %s requester custody through the installed SCM receiver',
    async source => runWithRealGitScmRuntime(async () => {
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-contributed-scm-' });
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
                run: async (_input, context) => context.services.actions.execute('scm.file.read', {
                    cwd: repository.rootPath, path: repository.trackedPath, selector: { commit: repository.headCommit },
                }),
            } },
        });
        const action = { pluginId: plugin.manifest.id, localId: 'prepare' };
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home read'));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
            if (availability) return availability;
            throw new Error(`Unexpected Home request: ${new URL(String(url)).pathname}`);
        });
        let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                runtimeOptions: { resolveCurrentMachineId: () => 'machine',
                    scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
                    machineActionDirectTargetTransport: { machineId: 'machine', invoke: rpc.invokeLocal.bind(rpc) },
                },
                plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                    instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            });
            const target = { kind: 'machine', machineId: 'machine' } as const;
            const installationId = source === 'foreign-installation' ? 'another-installation' : 'installation';
            const context: RpcActionExecutorContext = { surface: 'cli', authority: 'account_automation', externalActionTarget: target,
                ...(source !== 'absent' ? {
                    authenticatedLocalRootCustody: { serverIdentityId: 'home', accountId: 'owner', machineId: target.machineId, installationId },
                    requesterWorkAttributionV1: { serverId: 'home', accountId: 'owner', machineId: target.machineId, installationId },
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
                expect(result, JSON.stringify(result)).toMatchObject({ matched: true, result: { ok: true, result: {
                    success: true, contentBase64: Buffer.from('base\n').toString('base64'),
                } } });
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
            await rm(repository.rootPath, { recursive: true, force: true });
            vi.restoreAllMocks();
        }
    }),
);
