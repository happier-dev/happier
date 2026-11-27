import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import { z } from 'zod/mini';
import { isDeepStrictEqual } from 'node:util';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema,
    isSignedWorkspaceSyncHandoffReleaseV1, isWorkspaceSyncSourceWriterCleanupPhaseV1, isWorkspaceSyncSourceWriterTargetMethodV1, readWorkspaceSyncTargetMethodV1 } from '@happier-dev/protocol/socketRpc';
import { verifyWorkspaceSyncHandoffSourceAuthorization, readCurrentWorkspaceSyncHandoffWriterTarget,
    readCurrentWorkspaceSyncCopyRetirementAuthorization,
    resolveWorkspaceSyncSourceWriterCleanupDestination,
    verifyWorkspaceSyncProjectSourceAuthorization, readCurrentWorkspaceSyncProjectSourceAuthorization,
    hasCurrentExternalActionSessionSource, readCurrentWorkspaceSyncSeedAuthorization, verifyExternalActionMachineRpcExecution,
    verifyWorkspaceSyncSeedKeyCustody,
    resolveReceivingMachineRpcAdmission,
    prefetchWorkspaceSyncMachines } from '@/app/auth/externalActionExecutionAuthorization';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { buildMachineAdmissionFactsSelect, resolveMachineAdmission, resolveMachineAdmissionFromFactsInTx, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { hasCurrentMachineWorkspaceSyncStorageInTx, readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readDeploymentArchiveRpcEffectV1 } from '@happier-dev/protocol';
import { isSessionStopChildV1 } from '@happier-dev/protocol/actions/sessionSections';
import { readReviewedMachineRpcChildFamilyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { RequesterSessionCurrentnessPurposeV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { readCurrentSessionScopedMachineAccessFactsInTx } from '@/app/api/socket/sessionScopedBinding';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import type { Fastify } from '../../types';

/** Rechecks existing installation-signed RPC or requester Session facts; never issues an admission credential. */
export function registerMachineAdmissionRoutes(app: Fastify): void {
    app.post('/v1/machines/:id/admission/verify', {
        preHandler: app.authenticate,
        schema: {
            params: z.strictObject({ id: z.string().check(z.minLength(1)) }),
            body: z.strictObject({
                v: z.literal(1),
                context: SocketRpcMachineAdmissionContextV1Schema,
                method: z.optional(z.string().check(z.minLength(1))),
                purpose: z.optional(RequesterSessionCurrentnessPurposeV1Schema),
                workspaceSyncSourceRouting: z.optional(WorkspaceSyncSourceRoutingV1Schema),
                workspaceSyncTargetRouting: z.optional(WorkspaceSyncTargetRoutingV1Schema),
                workspaceSyncSourceWriterTargetRouting: z.optional(WorkspaceSyncSourceWriterTargetRoutingV1Schema),
                workspaceSyncSourceExecution: z.optional(WorkspaceSyncSourceExecutionV1Schema),
                workspaceSyncSeedRouting: z.optional(WorkspaceSyncSeedRoutingV1Schema),
                callerInputAuthorization: z.optional(ExternalActionExecutionAuthorizationV1Schema),
                custodySubjectAccountId: z.optional(z.string().check(z.minLength(1))),
                proof: MachineInstallationProofV1Schema,
            }),
        },
    }, async (request, reply) => {
        const { context, proof, purpose, custodySubjectAccountId, workspaceSyncSourceRouting, workspaceSyncTargetRouting,
            workspaceSyncSourceWriterTargetRouting: writerRouting, callerInputAuthorization, workspaceSyncSourceExecution, workspaceSyncSeedRouting } = request.body;
        const method = request.body.method ?? '';
        if (workspaceSyncSourceExecution?.originalActionEnvelope || workspaceSyncSourceExecution?.externalActionExecution.deploymentChildExecution) {
            const packet = workspaceSyncSourceExecution;
            const archiveMethod = packet.externalActionExecution.deploymentChildExecution
                ? readDeploymentArchiveRpcEffectV1(method.slice(method.indexOf(':') + 1)) : null;
            // The one cross-Machine child owner names the family; the archive packet keeps its own path.
            const childFamily = callerInputAuthorization ? readReviewedMachineRpcChildFamilyV1({ binding: callerInputAuthorization.binding,
                effectActionId: packet.externalActionExecution.effectActionId, method: method.slice(method.indexOf(':') + 1),
                target: context, reviewedChild: packet.externalActionExecution.reviewedChild }) : null;
            const childOperand = childFamily === 'stop' ? isSessionStopChildV1({ rootActionId: callerInputAuthorization?.binding.actionId ?? '',
                    effectActionId: packet.externalActionExecution.effectActionId, method: RPC_METHODS.STOP_SESSION,
                    target: packet.externalActionExecution.target, params: packet.params })
                : childFamily === 'deployment' ? packet.externalActionExecution.deploymentChildRouting !== undefined
                : childFamily === 'setup_plan' || childFamily === 'backup_receiver_setup' ? context.role === 'manage'
                : childFamily !== null;
            if (!callerInputAuthorization || !(childOperand
                || (callerInputAuthorization.binding.deploymentChildRoot === true) && archiveMethod !== null)
                || !isDeepStrictEqual(packet.externalActionExecution.authorization, callerInputAuthorization)
                || packet.method !== method || !method.startsWith(`${request.params.id}:`)
                || context.machineId !== request.params.id
                || purpose || custodySubjectAccountId || workspaceSyncSourceRouting || workspaceSyncTargetRouting || writerRouting || workspaceSyncSeedRouting) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const receiver = await db.machine.findUnique({ where: { id: request.params.id },
                select: withMachineContentSelect({ ...buildMachineAdmissionFactsSelect(context.actorAccountId), installationPublicKey: true }) }).then(decodeMachineStoredContent);
            if (!receiver?.installationId || !receiver.installationPublicKey || receiver.accountId !== request.userId
                || receiver.installationId !== context.installationId || receiver.accountId !== context.custodianAccountId
                || classifyMachineAvailabilityState(receiver) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: receiver.id,
                    installationId: receiver.installationId, accountId: request.userId,
                    rpcAdmission: { context, method, callerInputAuthorization, workspaceSyncSourceExecution: packet } },
                    proof, publicKey: encodeBase64(receiver.installationPublicKey, 'base64url') })) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const verified = await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, {
                    method: packet.method, requestId: packet.requestId, params: packet.params,
                    originalActionEnvelope: packet.originalActionEnvelope, resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
            if (!verified || context.actorAccountId !== (verified.deploymentChildSigner?.custodianAccountId ?? verified.binding.accountId)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            if (verified.sessionAgentReadinessAdmission) {
                const { kind: _kind, ...expected } = verified.sessionAgentReadinessAdmission;
                return isDeepStrictEqual(context, expected) ? reply.send({ v: 1, ok: true })
                    : reply.code(403).send({ error: 'access_denied' });
            }
            if (archiveMethod && verified.deploymentChildCodecAdmission) {
                const expected = { ...verified.deploymentChildCodecAdmission, actorAccountId: context.actorAccountId, role: 'use' as const };
                return isDeepStrictEqual(context, expected) ? reply.send({ v: 1, ok: true })
                    : reply.code(403).send({ error: 'access_denied' });
            }
            const child = verified.deploymentChildAdmission;
            if (child && child.routing.kind !== 'prepare' && child.routing.kind !== 'review'
                && child.routing.kind !== 'domainDiscover' && child.routing.kind !== 'domainReview'
                && (child.routing.kind !== 'domain' || child.routing.actionId !== 'deployments.domains.verify')) {
                // This exact job was already admitted above. The receiver proves
                // its own installation; the original requester is attribution.
                return reply.send({ v: 1, ok: true });
            }
            const current = await resolveMachineAdmissionFromFactsInTx(db, receiver, { actorAccountId: context.actorAccountId, machineId: receiver.id,
                callerAuthority: verified.effectiveAuthority, sessionActionOrigin: verified.binding.sessionActionOrigin,
                executionBinding: verified.binding,
                operationRpcMethod: method.slice(method.indexOf(':') + 1),
                ...(archiveMethod ? { rpcMethod: method.slice(method.indexOf(':') + 1) } : { requiredRole: context.role }) });
            if (current.kind !== 'admitted' || current.installationId !== context.installationId
                || current.custodianAccountId !== context.custodianAccountId || current.encryptionMode !== context.encryptionMode
                || archiveMethod && current.role !== context.role) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            return reply.send({ v: 1, ok: true });
        }
        if (workspaceSyncTargetRouting && isWorkspaceSyncSourceWriterCleanupPhaseV1(workspaceSyncTargetRouting.phase)
            && workspaceSyncTargetRouting.phase !== 'release') {
            return reply.code(403).send({ error: 'access_denied' });
        }
        if (workspaceSyncSeedRouting) {
            if (!callerInputAuthorization || purpose || custodySubjectAccountId
                || workspaceSyncSourceRouting || workspaceSyncTargetRouting || writerRouting
                || !isDeepStrictEqual(context, workspaceSyncSeedRouting.sourceWriterTarget.source.sourceContext.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const { sourceWriter } = workspaceSyncSeedRouting.sourceWriterTarget;
            const prefetchedMachines = await prefetchWorkspaceSyncMachines([
                request.params.id,
                callerInputAuthorization.binding.machineId,
                workspaceSyncSeedRouting.sourceWriterTarget.source.sourceMachineId,
                sourceWriter.machineId,
                workspaceSyncSeedRouting.target.targetMachineId,
            ]);
            const signer = prefetchedMachines.get(request.params.id) ?? null;
            if (!signer?.installationId || !signer.installationPublicKey || signer.accountId !== request.userId
                || classifyMachineAvailabilityState(signer) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: signer.id, installationId: signer.installationId,
                    accountId: request.userId, rpcAdmission: { context, method, workspaceSyncSeedRouting, callerInputAuthorization, workspaceSyncSourceExecution } },
                    proof, publicKey: encodeBase64(signer.installationPublicKey, 'base64url') })) return reply.code(403).send({ error: 'access_denied' });
            const callerIsTarget = signer.id === workspaceSyncSeedRouting.target.targetMachineId && signer.id !== sourceWriter.machineId;
            let receivingMachineAdmission;
            if (callerIsTarget) {
                if (!await verifyWorkspaceSyncSeedKeyCustody({ authorization: callerInputAuthorization,
                    routing: workspaceSyncSeedRouting, sourceExecution: workspaceSyncSourceExecution, method,
                    signer: { machineId: signer.id, installationId: signer.installationId, custodianAccountId: signer.accountId },
                    prefetchedMachines })
                    || signer.managedResource !== null && !await hasCurrentMachineWorkspaceSyncStorageInTx(db, {
                        accountServerId: workspaceSyncSeedRouting.target.accountServerId, machineId: signer.id })) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
            } else {
                // Direct receiver ingress still has to admit the execution itself.
                if (signer.id !== sourceWriter.machineId || signer.installationId !== sourceWriter.installationId
                    || method !== `${sourceWriter.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                const admitted = await readCurrentWorkspaceSyncSeedAuthorization(callerInputAuthorization, workspaceSyncSeedRouting,
                    workspaceSyncSourceExecution, app.resolveCurrentSessionMachine, prefetchedMachines);
                if (!admitted) return reply.code(403).send({ error: 'access_denied' });
                receivingMachineAdmission = await resolveReceivingMachineRpcAdmission({
                    actorAccountId: admitted.verified.binding.accountId, rpcMethod: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                    receiver: admitted.writer, admitted: admitted.receivingMachineAdmission ?? context,
                    prefetchedMachines,
                });
            }
            const destination = callerIsTarget ? prefetchedMachines.get(sourceWriter.machineId) ?? null : signer;
            if (!destination?.installationPublicKey || destination.installationId !== sourceWriter.installationId
                || classifyMachineAvailabilityState(destination) !== 'available') {
                return reply.code(403).send({ error: 'access_denied' });
            }
            return reply.send({ v: 1, ok: true, ...(receivingMachineAdmission ? { receivingMachineAdmission } : {}),
                destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        if (!writerRouting && (workspaceSyncSourceExecution || workspaceSyncSourceRouting?.originalActionEnvelope)) {
            // Only the original Project D packet can attest decrypted Source
            // facts to the installed P1. It is not a handoff or generic proof.
            if (!workspaceSyncSourceRouting || !callerInputAuthorization || writerRouting || workspaceSyncTargetRouting
                || purpose || custodySubjectAccountId
                || !(method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`)
                    || method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`))
                || workspaceSyncSourceExecution && (method !== workspaceSyncSourceExecution.method
                    || !method.startsWith(`${request.params.id}:`))
                || !isDeepStrictEqual(context, workspaceSyncSourceRouting.sourceContext?.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const methodTargetMachineId = method.indexOf(':') > 0 ? method.slice(0, method.indexOf(':')) : null;
            const prefetchedMachines = await prefetchWorkspaceSyncMachines([
                request.params.id,
                callerInputAuthorization.binding.machineId,
                workspaceSyncSourceRouting.sourceMachineId,
                methodTargetMachineId,
            ]);
            const writer = prefetchedMachines.get(request.params.id) ?? null;
            if (!writer?.installationId || !writer.installationPublicKey || writer.accountId !== request.userId
                || !workspaceSyncSourceExecution && writer.accountId !== callerInputAuthorization.binding.custodianAccountId
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
                    workspaceSyncSourceRouting, workspaceSyncSourceExecution, app.resolveCurrentSessionMachine, prefetchedMachines)
                : await readCurrentWorkspaceSyncProjectSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting,
                    method.slice(0, method.indexOf(':')), app.resolveCurrentSessionMachine, prefetchedMachines);
            if (!admitted || workspaceSyncSourceExecution && (admitted.route.parentMachineId !== writer.id
                || admitted.route.parentInstallationId !== writer.installationId
                || admitted.route.custodianAccountId !== writer.accountId)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = prefetchedMachines.has(admitted.route.parentMachineId)
                ? prefetchedMachines.get(admitted.route.parentMachineId) ?? null
                : await db.machine.findUnique({ where: { id: admitted.route.parentMachineId } }).then(decodeMachineStoredContent);
            if (!destination?.installationId || !destination.installationPublicKey
                || destination.installationId !== admitted.route.parentInstallationId
                || classifyMachineAvailabilityState(destination) !== 'available') return reply.code(403).send({ error: 'access_denied' });
            const receivingMachineAdmission = await resolveReceivingMachineRpcAdmission({
                actorAccountId: admitted.verified.binding.accountId, rpcMethod: method.slice(method.indexOf(':') + 1),
                receiver: { machineId: destination.id, installationId: destination.installationId },
                admitted: admitted.receivingMachineAdmission,
                prefetchedMachines });
            return reply.send({ v: 1, ok: true, ...(receivingMachineAdmission ? { receivingMachineAdmission } : {}),
                destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        if (writerRouting) {
            const signedHandoffRelease = isSignedWorkspaceSyncHandoffReleaseV1(writerRouting, callerInputAuthorization);
            const cleanup = isWorkspaceSyncSourceWriterCleanupPhaseV1(writerRouting.target.phase) && !signedHandoffRelease;
            if (purpose || custodySubjectAccountId || workspaceSyncSourceRouting
                || writerRouting.source.accountServerId !== await getOrCreateServerIdentityId()
                || !isWorkspaceSyncSourceWriterTargetMethodV1(writerRouting.target.phase, method.slice(method.indexOf(':') + 1))
                || (cleanup ? Boolean(workspaceSyncTargetRouting || workspaceSyncSourceExecution)
                    || (!callerInputAuthorization && writerRouting.target.phase === 'remove') : !callerInputAuthorization)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const methodMachineId = method.indexOf(':') > 0 ? method.slice(0, method.indexOf(':')) : null;
            const prefetchedMachines = await prefetchWorkspaceSyncMachines([
                request.params.id,
                callerInputAuthorization?.binding.machineId,
                writerRouting.source.sourceMachineId,
                writerRouting.sourceWriter.machineId,
                writerRouting.target.targetMachineId,
                workspaceSyncTargetRouting?.targetMachineId,
                methodMachineId,
            ]);
            const retirement = callerInputAuthorization && (writerRouting.target.phase === 'inspect' || writerRouting.target.phase === 'remove')
                ? await readCurrentWorkspaceSyncCopyRetirementAuthorization(callerInputAuthorization, writerRouting, app.resolveCurrentSessionMachine, prefetchedMachines) : null;
            if (cleanup && callerInputAuthorization && !retirement) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const receiver = prefetchedMachines.get(request.params.id) ?? null;
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
            if (cleanup) {
                const cleanupAdmitted = await resolveWorkspaceSyncSourceWriterCleanupDestination({
                    routing: writerRouting,
                    method,
                    retirementActorAccountId: retirement?.binding.accountId ?? null,
                    prefetchedMachines,
                });
                if (!cleanupAdmitted) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                const { kind: _kind, ...transport } = cleanupAdmitted.writer;
                if (!isDeepStrictEqual(context, transport)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                if (receiver.id === cleanupAdmitted.writer.machineId
                    && receiver.installationId === cleanupAdmitted.writer.installationId) {
                    const { destination } = cleanupAdmitted;
                    return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                        installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
                }
                if (receiver.id !== cleanupAdmitted.destination.id
                    || receiver.installationId !== cleanupAdmitted.destination.installationId) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                return reply.send({ v: 1, ok: true });
            }
            const writer = await resolveMachineAdmissionFromFactsInTx(db, prefetchedMachines.get(writerRouting.sourceWriter.machineId) ?? null, {
                actorAccountId: writerRouting.source.sourceContext.machineAdmission.custodianAccountId,
                machineId: writerRouting.sourceWriter.machineId, requiredRole: 'manage',
            });
            if (writer.kind !== 'admitted' || writer.installationId !== writerRouting.sourceWriter.installationId) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const admitted = callerInputAuthorization
                && await readCurrentWorkspaceSyncHandoffWriterTarget(callerInputAuthorization, writerRouting, app.resolveCurrentSessionMachine,
                    workspaceSyncTargetRouting ? { routing: workspaceSyncTargetRouting, machineId: method.slice(0, method.indexOf(':')) } : undefined,
                    workspaceSyncSourceExecution, prefetchedMachines);
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
                if (method !== `${route.parentMachineId}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`
                    || (receiver.id === target.machineId ? receiver.installationId !== target.installationId
                        : receiver.id !== route.parentMachineId || receiver.installationId !== route.parentInstallationId)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                destinationId = route.parentMachineId;
                destinationInstallationId = route.parentInstallationId;
            } else if (signedHandoffRelease
                && receiver.id === target.machineId && receiver.installationId === target.installationId) {
                const { kind: _kind, ...targetAdmission } = target;
                if (method !== `${target.machineId}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`
                    || !isDeepStrictEqual(context, targetAdmission)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                return reply.send({ v: 1, ok: true });
            } else if (receiver.id !== writer.machineId || receiver.installationId !== writer.installationId
                || method !== `${target.machineId}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`
                || !isDeepStrictEqual(context, writerRouting.source.sourceContext.machineAdmission)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = prefetchedMachines.has(destinationId)
                ? prefetchedMachines.get(destinationId) ?? null
                : await db.machine.findUnique({ where: { id: destinationId } }).then(decodeMachineStoredContent);
            if (!destination?.installationId || destination.installationId !== destinationInstallationId || !destination.installationPublicKey
                || classifyMachineAvailabilityState(destination) !== 'available'
                || !admitted.verified.binding.handoffAdmission
                    && !await hasCurrentExternalActionSessionSource(admitted.verified.binding, app.resolveCurrentSessionMachine)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        const isRequesterSessionCurrentness = purpose !== undefined;
        const refuse = (stage: 'request_binding' | 'installation_proof' | 'machine_admission' | 'session_binding') => {
            if (purpose) app.log.warn({ event: 'machine_admission_refused', purpose: purpose.kind,
                stage, sessionId: purpose.sessionId });
            return reply.code(403).send({ error: 'access_denied' });
        };
        const prefix = `${request.params.id}:`;
        const isCustodyCleanup = method === `${prefix}${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const isWorkspaceSyncSource = workspaceSyncSourceRouting !== undefined
            && method === `${prefix}${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const isWorkspaceSyncTarget = workspaceSyncTargetRouting !== undefined
            && method === `${prefix}${readWorkspaceSyncTargetMethodV1(workspaceSyncTargetRouting.phase)}`;
        const isWorkspaceSyncChild = isWorkspaceSyncSource || isWorkspaceSyncTarget;
        const workspaceSyncRouting = workspaceSyncSourceRouting ?? workspaceSyncTargetRouting;
        const workspaceSyncContext = workspaceSyncSourceRouting?.sourceContext ?? workspaceSyncTargetRouting?.targetContext;
        const childMachineId = workspaceSyncSourceRouting?.sourceMachineId ?? workspaceSyncTargetRouting?.targetMachineId;
        const childRootPath = workspaceSyncSourceRouting?.sourceRootPath ?? workspaceSyncTargetRouting?.targetRootPath;
        const isWorkspaceSyncChildRelease = isWorkspaceSyncChild && (workspaceSyncRouting?.phase === 'commit'
            || workspaceSyncRouting?.phase === 'abort' || workspaceSyncRouting?.phase === 'release');
        const requester = { callerAuthority: workspaceSyncContext?.callerAuthority
                ?? readTeamOperationAuthenticationFromRequest(request).authenticationAuthority,
            sessionActionOrigin: workspaceSyncContext?.sessionActionOrigin };
        if ((!isWorkspaceSyncChild && context.machineId !== request.params.id)
            || !isWorkspaceSyncChild && request.userId !== context.custodianAccountId
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
            return refuse('request_binding');
        }
        const machine = await db.machine.findUnique({ where: { id: request.params.id },
            select: { accountId: true, installationId: true, installationPublicKey: true } });
        if (!machine
            || machine.accountId !== request.userId
            || !machine.installationId
            || (!isWorkspaceSyncChild && machine.installationId !== context.installationId)
            || !machine.installationPublicKey
            || !verifyMachineInstallationProof({
                payload: { version: 1, machineId: request.params.id, installationId: machine.installationId,
                    accountId: machine.accountId, rpcAdmission: { context,
                        ...(purpose ? { purpose } : { method }),
                        ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting } : {}),
                        ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting } : {}),
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}),
                        ...(custodySubjectAccountId ? { custodySubjectAccountId } : {}) } },
                publicKey: encodeBase64(machine.installationPublicKey, 'base64url'),
                proof,
            })) {
            return refuse('installation_proof');
        }
        const verifiedSource = callerInputAuthorization && workspaceSyncSourceRouting
            ? await verifyWorkspaceSyncHandoffSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting) : null;
        if (callerInputAuthorization && !verifiedSource) return reply.code(403).send({ error: 'access_denied' });
        const operation = {
            actorAccountId: isWorkspaceSyncChildRelease ? context.custodianAccountId : context.actorAccountId,
            ...requester,
            machineId: context.machineId,
            operationRpcMethod: method.slice(prefix.length),
        };
        const current = purpose ? await inTx(async tx => {
            const access = await readCurrentSessionScopedMachineAccessFactsInTx({
                tx, accountId: context.actorAccountId, machineId: context.machineId, sessionId: purpose.sessionId,
            });
            if (!access || access.session.accountId !== context.actorAccountId) return null;
            return resolveMachineAdmissionFromFactsInTx(tx, access.machine, {
                ...operation, requiredRole: context.role, actionId: 'session.open',
            });
        }) : verifiedSource?.sourceMachineAdmission ?? await resolveMachineAdmission({
            ...operation,
            ...(isWorkspaceSyncChild ? { requiredRole: 'use' as const } : { rpcMethod: operation.operationRpcMethod }),
        });
        if (!current) return refuse('session_binding');
        if (current.kind !== 'admitted' || !verifiedSource && (
            current.custodianAccountId !== context.custodianAccountId
            || current.installationId !== context.installationId
            || current.encryptionMode !== context.encryptionMode
            || (isWorkspaceSyncChild && !isWorkspaceSyncChildRelease && context.role === 'manage' && current.role !== 'manage')
        )) return refuse('machine_admission');
        if (workspaceSyncRouting && childMachineId && childRootPath) {
            const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, {
                accountServerId: workspaceSyncRouting.accountServerId,
                operation: { actorAccountId: isWorkspaceSyncChildRelease ? context.custodianAccountId : context.actorAccountId,
                    ...requester,
                    rpcMethod: method.slice(prefix.length) },
                childMachineId, childRootPath,
                parentMachineId: request.params.id,
                releaseOnly: isWorkspaceSyncChildRelease,
            });
            if (!route || route.custodianAccountId !== machine.accountId
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
