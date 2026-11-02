import axios from 'axios';
import { onTestFinished, vi } from 'vitest';
import { ApiMachineClient, type ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { createProjectSessionRuntimeFixture } from './projectSessionRuntimeFixture';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

/** Real installed Machine receiver; only authenticated Home HTTP is substituted.
 * No saved exact Home descriptor is needed when the connection holds its Home. */
export async function createInstalledFilesystemMachineFixture(options: Readonly<{
    accountSettings?: Readonly<Record<string, unknown>>;
    boundSessionId?: string;
    directTransferExport?: Parameters<ApiMachineClient['setRPCHandlers']>[0]['directTransferExport'];
    agentIsolation?: ApiMachineClientLifecycleDependencies['agentIsolation'];
    createProjectFiniteRuntime?: ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime'];
}> = {}) {
    const homeServerIdentityId = 'srv_filesystem_held_owner';
    const f = await createProjectSessionRuntimeFixture({ serverId: 'filesystem-profile',
        homeServerIdentityId, serverUrl: 'https://session-home.test',
        ...(options.boundSessionId ? { boundSessionId: options.boundSessionId } : {}),
        ...(options.accountSettings ? { accountSettings: options.accountSettings } : {}) });
    let heldHome: string | null = homeServerIdentityId;
    let homeChecks = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (!String(url).endsWith('/v1/machines/machine/admission/verify') || !body || typeof body !== 'object'
            || !('context' in body) || !('proof' in body) || !('method' in body)) throw new Error('Unexpected Home admission request');
        const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
        const proof = MachineInstallationProofV1Schema.parse(body.proof);
        const ok = context.custodianAccountId === 'requester' && verifyMachineInstallationProof({ publicKey: f.installation.publicKey, proof,
            payload: { version: 1, accountId: 'requester', machineId: 'machine', installationId: f.installation.installationId,
                rpcAdmission: { context, method: String(body.method) } } });
        homeChecks++;
        return { status: ok && f.isHomeCurrent() ? 200 : 403,
            data: ok && f.isHomeCurrent() ? { v: 1, ok: true } : { error: 'access_denied' } };
    });
    const machine = new ApiMachineClient(f.bootstrap.credentials.token, { id: 'machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined,
        { resolveCurrentServerIdentityId: () => heldHome,
            ...(options.createProjectFiniteRuntime ? { createProjectFiniteRuntime: options.createProjectFiniteRuntime } : {}),
            ...(options.agentIsolation ? { agentIsolation: options.agentIsolation } : {}) });
    machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
        stopSession: async () => true, requestShutdown() {},
        ...(options.directTransferExport ? { directTransferExport: options.directTransferExport } : {}) });
    onTestFinished(() => machine.shutdown());
    // Network transport entry: retain actual authorization and its constructed
    // currentness callback rather than calling filesystem handlers directly.
    const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Machine RPC receiver');
    return { ...f, machine, rpcHandlerManager: manager, machineId: 'machine', homeServerIdentityId,
        serverId: 'filesystem-profile', serverHttpBaseUrl: 'https://session-home.test',
        admissionChecks: () => homeChecks,
        setHeldHome: (home: string | null) => { heldHome = home; },
        receive: (request: RpcRequest) => manager.handleRequest(request),
        invoke: (method: string, params: unknown, ingress: Readonly<{
            actorAccountId?: string; callerAuthority?: RpcRequest['callerAuthority']; role?: 'use' | 'manage';
            sessionActionOrigin?: RpcRequest['sessionActionOrigin']; callerInputAuthorization?: RpcRequest['callerInputAuthorization'];
        }> = {}) => manager.handleRequest({ method: `machine:${method}`, params,
            callerAuthority: ingress.callerAuthority ?? 'present_user',
            ...(ingress.sessionActionOrigin ? { sessionActionOrigin: ingress.sessionActionOrigin } : {}),
            ...(ingress.callerInputAuthorization ? { callerInputAuthorization: ingress.callerInputAuthorization } : {}),
            machineAdmission: { actorAccountId: ingress.actorAccountId ?? 'requester', custodianAccountId: 'requester',
                machineId: 'machine', installationId: f.installation.installationId, role: ingress.role ?? 'manage', encryptionMode: 'plain' } }),
    };
}
