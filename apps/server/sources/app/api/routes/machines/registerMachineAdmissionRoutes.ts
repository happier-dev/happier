import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
    encodeBase64,
    MachineInstallationProofV1Schema,
    SocketRpcMachineAdmissionContextV1Schema,
    verifyMachineInstallationProof,
    ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { verifyWorkspaceSyncHandoffSourceAuthorization, readCurrentWorkspaceSyncHandoffWriterTarget } from '@/app/auth/externalActionExecutionAuthorization';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveMachineAdmission, resolveMachineAdmissionInTx, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { RequesterSessionCurrentnessPurposeV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import type { Fastify } from '../../types';

/** Rechecks existing installation-signed RPC or requester Session facts; never issues an admission credential. */
export function registerMachineAdmissionRoutes(app: Fastify): void {
    app.post('/v1/machines/:id/admission/verify', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string().min(1) }).strict(),
            body: z.object({
                v: z.literal(1),
                context: SocketRpcMachineAdmissionContextV1Schema,
                method: z.string().min(1).optional(),
                purpose: RequesterSessionCurrentnessPurposeV1Schema.optional(),
                workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.optional(),
                workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.optional(),
                workspaceSyncSourceWriterTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1Schema.optional(),
                callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
                custodySubjectAccountId: z.string().min(1).optional(),
                proof: MachineInstallationProofV1Schema,
            }).strict(),
        },
    }, async (request, reply) => {
        const { context, proof, purpose, custodySubjectAccountId, workspaceSyncSourceRouting, workspaceSyncTargetRouting,
            workspaceSyncSourceWriterTargetRouting: writerRouting, callerInputAuthorization } = request.body;
        const method = request.body.method ?? '';
        const targetPhaseMethods = { preflight: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
            prepare: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
            release: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE };
        if (writerRouting) {
            const release = writerRouting.target.phase === 'release';
            if (purpose || custodySubjectAccountId || workspaceSyncSourceRouting
                || writerRouting.source.accountServerId !== await getOrCreateServerIdentityId()
                || method.slice(method.indexOf(':') + 1) !== targetPhaseMethods[writerRouting.target.phase]
                || (release ? Boolean(callerInputAuthorization || workspaceSyncTargetRouting) : !callerInputAuthorization)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const receiver = await db.machine.findUnique({ where: { id: request.params.id } });
            if (!receiver || receiver.accountId !== request.userId || !receiver.installationId || !receiver.installationPublicKey
                || classifyMachineAvailabilityState(receiver) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: receiver.id,
                    installationId: receiver.installationId, accountId: request.userId,
                    rpcAdmission: { context, method, workspaceSyncSourceWriterTargetRouting: writerRouting,
                        ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } }, proof,
                    publicKey: encodeBase64(receiver.installationPublicKey, 'base64url') })) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const writer = await resolveMachineAdmission({ actorAccountId: writerRouting.source.sourceContext.machineAdmission.custodianAccountId,
                machineId: writerRouting.sourceWriter.machineId, requiredRole: 'manage' });
            if (writer.kind !== 'admitted' || writer.installationId !== writerRouting.sourceWriter.installationId) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            if (release) {
                // The receiver's existing retained operation owns past target custody.
                // This Home proof authenticates only current writer/receiver transport.
                const { kind: _kind, ...transport } = writer;
                if (method !== `${receiver.id}:${targetPhaseMethods.release}` || !isDeepStrictEqual(context, transport)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                return reply.send({ v: 1, ok: true });
            }
            const admitted = callerInputAuthorization
                && await readCurrentWorkspaceSyncHandoffWriterTarget(callerInputAuthorization, writerRouting);
            if (!admitted) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const { target } = admitted;
            let destinationId = target.machineId;
            if (workspaceSyncTargetRouting) {
                const { targetContext, ...phase } = workspaceSyncTargetRouting;
                const { kind: _kind, ...targetAdmission } = target;
                if (!isDeepStrictEqual(phase, writerRouting.target) || !isDeepStrictEqual(context, targetContext.machineAdmission)
                    || !isDeepStrictEqual(targetContext.machineAdmission, targetAdmission)
                    || targetContext.callerAuthority !== writerRouting.source.sourceContext.callerAuthority
                    || !isDeepStrictEqual(targetContext.callerInputConstraints, writerRouting.source.sourceContext.callerInputConstraints)
                    || !isDeepStrictEqual(targetContext.sessionActionOrigin, writerRouting.source.sourceContext.sessionActionOrigin)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, {
                    accountServerId: workspaceSyncTargetRouting.accountServerId, childMachineId: target.machineId,
                    childRootPath: workspaceSyncTargetRouting.targetRootPath, parentMachineId: receiver.id, releaseOnly: false });
                if (!route || route.parentInstallationId !== receiver.installationId
                    || method !== `${receiver.id}:${targetPhaseMethods[writerRouting.target.phase]}`) return reply.code(403).send({ error: 'access_denied' });
                destinationId = receiver.id;
            } else if (receiver.id !== writer.machineId || receiver.installationId !== writer.installationId
                || method !== `${target.machineId}:${targetPhaseMethods[writerRouting.target.phase]}`
                || !isDeepStrictEqual(context, writerRouting.source.sourceContext.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = await db.machine.findUnique({ where: { id: destinationId } });
            if (!destination?.installationId || !destination.installationPublicKey
                || classifyMachineAvailabilityState(destination) !== 'available') return reply.code(403).send({ error: 'access_denied' });
            return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        const isRequesterSessionCurrentness = purpose !== undefined;
        const prefix = `${request.params.id}:`;
        const isCustodyCleanup = method === `${prefix}${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const isWorkspaceSyncSource = workspaceSyncSourceRouting !== undefined
            && method === `${prefix}${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const isWorkspaceSyncTarget = workspaceSyncTargetRouting !== undefined
            && method === `${prefix}${targetPhaseMethods[workspaceSyncTargetRouting.phase]}`;
        const isWorkspaceSyncChild = isWorkspaceSyncSource || isWorkspaceSyncTarget;
        const workspaceSyncRouting = workspaceSyncSourceRouting ?? workspaceSyncTargetRouting;
        const workspaceSyncContext = workspaceSyncSourceRouting?.sourceContext ?? workspaceSyncTargetRouting?.targetContext;
        const childMachineId = workspaceSyncSourceRouting?.sourceMachineId ?? workspaceSyncTargetRouting?.targetMachineId;
        const childRootPath = workspaceSyncSourceRouting?.sourceRootPath ?? workspaceSyncTargetRouting?.targetRootPath;
        const isWorkspaceSyncChildRelease = isWorkspaceSyncChild && (workspaceSyncRouting?.phase === 'commit'
            || workspaceSyncRouting?.phase === 'abort' || workspaceSyncRouting?.phase === 'release');
        if ((!isWorkspaceSyncChild && context.machineId !== request.params.id)
            || request.userId !== context.custodianAccountId
            || (isRequesterSessionCurrentness
                ? request.body.method !== undefined || custodySubjectAccountId !== undefined
                    || workspaceSyncSourceRouting !== undefined || workspaceSyncTargetRouting !== undefined
                : !method.startsWith(prefix) || method.length === prefix.length)
            || (isCustodyCleanup ? !custodySubjectAccountId || context.actorAccountId !== context.custodianAccountId
                : custodySubjectAccountId !== undefined)
            || (workspaceSyncSourceRouting !== undefined && !isWorkspaceSyncSource)
            || (workspaceSyncTargetRouting !== undefined && !isWorkspaceSyncTarget)
            || (workspaceSyncSourceRouting && workspaceSyncTargetRouting)
            || (callerInputAuthorization && (!isWorkspaceSyncSource || isWorkspaceSyncChildRelease))
            || (workspaceSyncRouting && (childMachineId !== context.machineId
                || (workspaceSyncContext && !isDeepStrictEqual(workspaceSyncContext.machineAdmission, context))))) {
            return reply.code(403).send({ error: 'access_denied' });
        }
        const machine = await db.machine.findUnique({ where: { id: request.params.id },
            select: { accountId: true, installationId: true, installationPublicKey: true } });
        if (!machine
            || machine.accountId !== context.custodianAccountId
            || !machine.installationId
            || (!isWorkspaceSyncChild && machine.installationId !== context.installationId)
            || !machine.installationPublicKey
            || !verifyMachineInstallationProof({
                payload: { version: 1, machineId: request.params.id, installationId: machine.installationId,
                    accountId: context.custodianAccountId, rpcAdmission: { context,
                        ...(purpose ? { purpose } : { method }),
                        ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting } : {}),
                        ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}),
                        ...(custodySubjectAccountId ? { custodySubjectAccountId } : {}) } },
                publicKey: encodeBase64(machine.installationPublicKey, 'base64url'),
                proof,
            })) {
            return reply.code(403).send({ error: 'access_denied' });
        }
        if (callerInputAuthorization && (!workspaceSyncSourceRouting
            || !await verifyWorkspaceSyncHandoffSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting))) {
            return reply.code(403).send({ error: 'access_denied' });
        }
        const current = await resolveMachineAdmission({ actorAccountId: isWorkspaceSyncChildRelease
            ? context.custodianAccountId : context.actorAccountId,
            machineId: context.machineId,
            ...(isWorkspaceSyncChild || isRequesterSessionCurrentness ? { requiredRole: 'use' as const } : { rpcMethod: method.slice(prefix.length) }) });
        if (current.kind !== 'admitted'
            || current.custodianAccountId !== context.custodianAccountId
            || current.installationId !== context.installationId
            || current.encryptionMode !== context.encryptionMode
            || ((isRequesterSessionCurrentness || isWorkspaceSyncChild && !isWorkspaceSyncChildRelease)
                && context.role === 'manage' && current.role !== 'manage')) {
            return reply.code(403).send({ error: 'access_denied' });
        }
        if (purpose) {
            const sessionCurrent = await inTx(async tx => {
                if (!await hasCurrentSessionScopedMachineAccessInTx({ tx,
                    accountId: context.actorAccountId, machineId: context.machineId, sessionId: purpose.sessionId })) return false;
                const final = await resolveMachineAdmissionInTx(tx, { actorAccountId: context.actorAccountId,
                    machineId: context.machineId, requiredRole: context.role });
                return final.kind === 'admitted' && final.custodianAccountId === context.custodianAccountId
                    && final.installationId === context.installationId && final.encryptionMode === context.encryptionMode;
            });
            if (!sessionCurrent) return reply.code(403).send({ error: 'access_denied' });
        }
        if (workspaceSyncRouting && childMachineId && childRootPath) {
            const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, {
                accountServerId: workspaceSyncRouting.accountServerId,
                childMachineId, childRootPath,
                parentMachineId: request.params.id,
                releaseOnly: isWorkspaceSyncChildRelease,
            });
            if (!route || route.custodianAccountId !== context.custodianAccountId
                || route.parentInstallationId !== machine.installationId) {
                return reply.code(403).send({ error: 'access_denied' });
            }
        }
        if (custodySubjectAccountId && await inTx(tx => resolveEffectiveMachineRoleInTx(tx, {
            actorAccountId: custodySubjectAccountId, machineId: context.machineId,
        })) !== null) return reply.code(403).send({ error: 'access_denied' });
        return reply.send({ v: 1, ok: true });
    });
}
