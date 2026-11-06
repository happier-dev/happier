import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { MACHINE_REBOOT_ACTION_IDS } from '@happier-dev/protocol/machines/rebootActionIdsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from './exec';
import { createManagedServicesOwner, type WorkspaceProjectManagedServiceSupervisionInput } from './managedServicesOwner';
import { createLightSqliteHarness } from '../../../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../../../server/sources/storage/db';
import { inTx } from '../../../../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../../../../server/sources/app/machines/machineAccess';
import { makeShareEligibleForTest } from '../../../../../../server/sources/testkit/shareEligibility.testkit';

describe('Machine reboot service summary', () => {
    it('captures both Accounts reboot service identities after real Manage admission without Account reads', async () => {
        const database = await createLightSqliteHarness({ tempDirPrefix: 'reboot-summary-admission-', initAuth: true, initEncrypt: true });
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: Object.freeze({}) as never,
            resolveScope: scope => scope,
        });
        const projectWorkspace = { id: 'workspace-one', serverId: 'server-one', machineId: 'machine-one',
            rootPath: process.cwd(), createdAtMs: 1 };
        const project: WorkspaceProjectManagedServiceSupervisionInput = {
            kind: 'workspace', workspace: projectWorkspace,
            declaration: { workspaceRefId: projectWorkspace.id, selection: { kind: 'manifest', name: 'worker' } },
            requester: { serverId: projectWorkspace.serverId, accountId: 'requester-one',
                machineId: projectWorkspace.machineId, installationId: 'installation-one' },
            cwd: projectWorkspace.rootPath, serviceId: 'project:workspace-one:manifest:worker',
            specIdentity: 'reviewed-worker-effect', isCurrent: () => true,
            processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
            authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                signal,
                assertCurrent() {},
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'reviewed-worker-effect',
                    toolchain: {
                        selection: { kind: 'host' }, root: projectWorkspace.rootPath,
                        platform: process.platform,
                        io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
                    },
                },
                launch: { command: process.execPath, args: [], cwd: projectWorkspace.rootPath, env: {}, release() {} },
            }),
        };
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const workspace = { ...project, requester: { ...project.requester, accountId: custodian.id } };
        const effects: string[] = [];
        const scope = { serverId: workspace.workspace.serverId, machineId: workspace.workspace.machineId };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: scope.machineId, accountId: custodian.id,
            installationId: workspace.requester.installationId, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'reboot-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: workspace.workspace.rootPath, happyHomeDir: workspace.workspace.rootPath }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        await makeShareEligibleForTest(custodian.id, member.id);
        const grant = async (level: 'admin' | 'view') => expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: scope.machineId,
            principal: { kind: 'account', accountId: member.id }, level,
        }))).toMatchObject({ kind: 'saved' });
        await grant('admin');
        let homeAdmission: Awaited<ReturnType<typeof resolveMachineAdmission>> | undefined;
        // Only Home HTTP/native processes are substituted. RPC policy,
        // receiving admission verification and the service owner remain real.
        const home = vi.spyOn(axios, 'post').mockImplementation(async (_url, body: unknown) => {
            if (!body || typeof body !== 'object' || !('context' in body) || !('method' in body) || typeof body.method !== 'string') {
                throw new Error('Expected Machine admission verification request');
            }
            const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
            expect(body.method).toBe(`${context.machineId}:${RPC_METHODS.MACHINES_REBOOT}`);
            const admitted = await resolveMachineAdmission({ actorAccountId: context.actorAccountId,
                machineId: context.machineId, rpcMethod: body.method.slice(context.machineId.length + 1) });
            homeAdmission = admitted;
            return admitted.kind === 'admitted' && admitted.role === context.role
                ? { status: 200, data: { v: 1, ok: true } }
                : { status: 403, data: { error: 'access_denied' } };
        });
        const accountReads = vi.spyOn(axios, 'request').mockRejectedValue(new Error('Reboot summary must not read Account content'));
        try {
            const other = { ...workspace, workspace: { ...workspace.workspace, id: 'workspace-two' },
                declaration: { ...workspace.declaration, workspaceRefId: 'workspace-two' },
                requester: { ...workspace.requester, accountId: member.id },
                serviceId: 'project:workspace-two:manifest:worker' };
            for (const project of [workspace, other]) await owner.superviseProject({ ...project,
                processSpec: { mode: { kind: 'native', builtinLifecycle: {
                    inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
                    stop: async () => { effects.push('stop'); return { status: 'stopped' }; },
                } } },
            });
            const admission = { actorAccountId: workspace.requester.accountId,
                custodianAccountId: workspace.requester.accountId, machineId: scope.machineId,
                installationId: workspace.requester.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
            const rpc = new RpcHandlerManager({ scopePrefix: scope.machineId, encryptionMode: 'plain', logger() {},
                authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: scope.machineId,
                    resolveInstallationId: () => admission.installationId,
                    resolveCustodianAccountId: async () => admission.custodianAccountId,
                    resolveHomeServerIdentityId: async () => scope.serverId,
                    verifyMachineAdmission: request => verifyMachineRpcAdmissionCurrent({ ...request,
                        privateKey: keys.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }),
                }),
            });
            let summary: Awaited<ReturnType<typeof owner.readMachineRebootServices>> | undefined;
            registerActionSpecRpcHandlers<'machines.reboot'>({ rpcHandlerManager: rpc,
                targetMachineId: scope.machineId, actionIds: MACHINE_REBOOT_ACTION_IDS,
                resolveActionExecutor: ({ ingress }) => ({ execute: async (_actionId, _input, context) => {
                    summary = await owner.readMachineRebootServices({ ...scope, context,
                        requesterAccountId: ingress?.machineAdmission?.actorAccountId });
                    return { ok: true, result: { kind: 'accepted', operation: { operationId: 'reboot-summary' }, bootedAt: 1 } };
                } }),
            });
            const request = { method: `${scope.machineId}:${RPC_METHODS.MACHINES_REBOOT}`,
                params: { ...scope, expectedInstallationId: admission.installationId }, callerAuthority: 'present_user' as const };
            for (const actorAccountId of [workspace.requester.accountId, other.requester.accountId]) {
                summary = undefined;
                homeAdmission = undefined;
                const result = await rpc.handleRequest({ ...request, machineAdmission: { ...admission, actorAccountId } });
                expect(homeAdmission).toMatchObject({ kind: 'admitted', role: 'manage' });
                expect(result).toMatchObject({ kind: 'accepted' });
                expect(summary).toEqual({ coverage: 'complete', services: [workspace, other].map(project => ({
                    serviceId: project.serviceId, phase: 'running', readiness: 'not_reported',
                })) });
            }
            expect(accountReads).not.toHaveBeenCalled();
            await grant('view');
            for (const machineAdmission of [
                { ...admission, actorAccountId: other.requester.accountId, role: 'use' as const },
                { ...admission, actorAccountId: foreign.id },
                { ...admission, actorAccountId: foreign.id, custodianAccountId: foreign.id },
            ]) {
                summary = undefined;
                expect(await rpc.handleRequest({ ...request, machineAdmission })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect(summary).toBeUndefined();
            }
            expect(effects).toEqual([]);
        } finally { home.mockRestore(); accountReads.mockRestore(); await owner.dispose(); await database.close(); }
    });
});
