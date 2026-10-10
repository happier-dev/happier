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
    WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { verifyWorkspaceSyncHandoffSourceAuthorization, readCurrentWorkspaceSyncHandoffWriterTarget,
    verifyWorkspaceSyncProjectSourceAuthorization, readCurrentWorkspaceSyncProjectSourceAuthorization,
    hasCurrentExternalActionSessionSource, readCurrentWorkspaceSyncSeedAuthorization } from '@/app/auth/externalActionExecutionAuthorization';
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
                workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.optional(),
                workspaceSyncSeedRouting: WorkspaceSyncSeedRoutingV1Schema.optional(),
                callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
                custodySubjectAccountId: z.string().min(1).optional(),
                proof: MachineInstallationProofV1Schema,
            }).strict(),
        },
    }, async (request, reply) => {
        const { context, proof, purpose, custodySubjectAccountId, workspaceSyncSourceRouting, workspaceSyncTargetRouting,
            workspaceSyncSourceWriterTargetRouting: writerRouting, callerInputAuthorization, workspaceSyncSourceExecution, workspaceSyncSeedRouting } = request.body;
        const method = request.body.method ?? '';
        const targetPhaseMethods = { preflight: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
            prepare: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
            release: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE };
        if (workspaceSyncSeedRouting) {
            if (!callerInputAuthorization || !workspaceSyncSourceExecution || purpose || custodySubjectAccountId
                || workspaceSyncSourceRouting || workspaceSyncTargetRouting || writerRouting
                || !isDeepStrictEqual(context, workspaceSyncSeedRouting.sourceWriterTarget.source.sourceContext.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const signer = await db.machine.findUnique({ where: { id: request.params.id } });
            if (!signer?.installationId || !signer.installationPublicKey || signer.accountId !== request.userId
                || classifyMachineAvailabilityState(signer) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: signer.id, installationId: signer.installationId,
                    accountId: request.userId, rpcAdmission: { context, method, workspaceSyncSeedRouting, callerInputAuthorization, workspaceSyncSourceExecution } },
                    proof, publicKey: encodeBase64(signer.installationPublicKey, 'base64url') })) return reply.code(403).send({ error: 'access_denied' });
            const admitted = await readCurrentWorkspaceSyncSeedAuthorization(callerInputAuthorization, workspaceSyncSeedRouting,
                workspaceSyncSourceExecution, app.resolveCurrentSessionMachine);
            const route = admitted?.physicalTarget;
            if (!admitted || !route || method !== `${admitted.writer.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
                || (signer.id === admitted.writer.machineId ? signer.installationId !== admitted.writer.installationId
                    : signer.id !== route.machineId || signer.installationId !== route.installationId)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = await db.machine.findUnique({ where: { id: admitted.writer.machineId } });
            if (!destination?.installationPublicKey || destination.installationId !== admitted.writer.installationId
                || classifyMachineAvailabilityState(destination) !== 'available'
                || !await hasCurrentExternalActionSessionSource(admitted.verified.binding, app.resolveCurrentSessionMachine)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        if (!writerRouting && (workspaceSyncSourceExecution || workspaceSyncSourceRouting?.originalActionEnvelope)) {
            // Only the original Project D packet can attest decrypted Source
            // facts to the installed P1. It is not a handoff or generic proof.
            if (!workspaceSyncSourceRouting || !callerInputAuthorization || writerRouting || workspaceSyncTargetRouting
                || purpose || custodySubjectAccountId
                || !method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`)
                || workspaceSyncSourceExecution && (method !== workspaceSyncSourceExecution.method
                    || method !== `${request.params.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`)
                || !isDeepStrictEqual(context, workspaceSyncSourceRouting.sourceContext?.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const writer = await db.machine.findUnique({ where: { id: request.params.id } });
            if (!writer?.installationId || !writer.installationPublicKey || writer.accountId !== request.userId
                || writer.accountId !== (workspaceSyncSourceExecution ? context.custodianAccountId : callerInputAuthorization.binding.custodianAccountId)
                || !workspaceSyncSourceExecution && (writer.id !== callerInputAuthorization.binding.machineId
                    || writer.installationId !== callerInputAuthorization.binding.installationId)
                || classifyMachineAvailabilityState(writer) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: writer.id,
                    installationId: writer.installationId, accountId: request.userId,
                    rpcAdmission: { context, method, workspaceSyncSourceRouting, callerInputAuthorization,
                        ...(workspaceSyncSourceExecution ? { workspaceSyncSourceExecution } : {}) } },
                    proof, publicKey: encodeBase64(writer.installationPublicKey, 'base64url') })) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const admitted = workspaceSyncSourceExecution
                ? await verifyWorkspaceSyncProjectSourceAuthorization(callerInputAuthorization,
                    workspaceSyncSourceRouting, workspaceSyncSourceExecution, app.resolveCurrentSessionMachine)
                : await readCurrentWorkspaceSyncProjectSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting,
                    method.slice(0, method.indexOf(':')), app.resolveCurrentSessionMachine);
            if (!admitted || workspaceSyncSourceExecution && (admitted.route.parentMachineId !== writer.id
                || admitted.route.parentInstallationId !== writer.installationId)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = await db.machine.findUnique({ where: { id: admitted.route.parentMachineId } });
            if (!destination?.installationId || !destination.installationPublicKey
                || destination.installationId !== admitted.route.parentInstallationId
                || classifyMachineAvailabilityState(destination) !== 'available') return reply.code(403).send({ error: 'access_denied' });
            return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        if (writerRouting) {
            const release = writerRouting.target.phase === 'release';
            if (purpose || custodySubjectAccountId || workspaceSyncSourceRouting
                || writerRouting.source.accountServerId !== await getOrCreateServerIdentityId()
                || method.slice(method.indexOf(':') + 1) !== targetPhaseMethods[writerRouting.target.phase]
                || (release ? Boolean(callerInputAuthorization || workspaceSyncTargetRouting || workspaceSyncSourceExecution) : !callerInputAuthorization)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const receiver = await db.machine.findUnique({ where: { id: request.params.id } });
            if (!receiver || receiver.accountId !== request.userId || !receiver.installationId || !receiver.installationPublicKey
                || classifyMachineAvailabilityState(receiver) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: receiver.id,
                    installationId: receiver.installationId, accountId: request.userId,
                    rpcAdmission: { context, method, workspaceSyncSourceWriterTargetRouting: writerRouting,
                        ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                        ...(workspaceSyncSourceExecution ? { workspaceSyncSourceExecution } : {}),
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
                && await readCurrentWorkspaceSyncHandoffWriterTarget(callerInputAuthorization, writerRouting, app.resolveCurrentSessionMachine,
                    workspaceSyncTargetRouting ? { routing: workspaceSyncTargetRouting, machineId: method.slice(0, method.indexOf(':')) } : undefined,
                    workspaceSyncSourceExecution);
            if (!admitted) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const { target } = admitted;
            let destinationId = target.machineId;
            let destinationInstallationId = target.installationId;
            if (workspaceSyncTargetRouting) {
                const route = admitted.targetRoute;
                if (!route || !isDeepStrictEqual(context, workspaceSyncTargetRouting.targetContext.machineAdmission)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                // The chosen D can ask Home for its physical P2 before sending
                // the second hop. The same paired purpose also admits P2's
                // receiver-side proof; neither changes the original Root.
                if (method !== `${route.parentMachineId}:${targetPhaseMethods[writerRouting.target.phase]}`
                    || (receiver.id === target.machineId ? receiver.installationId !== target.installationId
                        : receiver.id !== route.parentMachineId || receiver.installationId !== route.parentInstallationId)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                destinationId = route.parentMachineId;
                destinationInstallationId = route.parentInstallationId;
            } else if (receiver.id !== writer.machineId || receiver.installationId !== writer.installationId
                || method !== `${target.machineId}:${targetPhaseMethods[writerRouting.target.phase]}`
                || !isDeepStrictEqual(context, writerRouting.source.sourceContext.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = await db.machine.findUnique({ where: { id: destinationId } });
            if (!destination?.installationId || destination.installationId !== destinationInstallationId || !destination.installationPublicKey
                || classifyMachineAvailabilityState(destination) !== 'available'
                || !await hasCurrentExternalActionSessionSource(admitted.verified.binding, app.resolveCurrentSessionMachine)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
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
            || (isCustodyCleanup ? context.actorAccountId !== context.custodianAccountId
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
            || !await verifyWorkspaceSyncHandoffSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting, app.resolveCurrentSessionMachine))) {
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
        if (callerInputAuthorization && !await hasCurrentExternalActionSessionSource(callerInputAuthorization.binding,
            app.resolveCurrentSessionMachine)) return reply.code(403).send({ error: 'access_denied' });
        return reply.send({ v: 1, ok: true });
    });
}
