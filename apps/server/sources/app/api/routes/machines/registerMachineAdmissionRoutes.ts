import { z } from 'zod/mini';
import { isDeepStrictEqual } from 'node:util';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof, SessionApprovalDecisionCurrentnessV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema,
    isWorkspaceSyncSourceWriterCleanupPhaseV1, readWorkspaceSyncTargetMethodV1 } from '@happier-dev/protocol/socketRpc';
import { verifyWorkspaceSyncHandoffSourceAuthorization, readCurrentWorkspaceSyncHandoffWriterTarget,
    readCurrentWorkspaceSyncCopyRetirementAuthorization,
    verifyWorkspaceSyncProjectSourceAuthorization, readCurrentWorkspaceSyncProjectSourceAuthorization,
    hasCurrentExternalActionSessionSource, readCurrentWorkspaceSyncSeedAuthorization, verifyExternalActionMachineRpcExecution,
    resolveReceivingMachineRpcAdmission } from '@/app/auth/externalActionExecutionAuthorization';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { buildMachineAdmissionFactsSelect, resolveMachineAdmission, resolveMachineAdmissionFromFactsInTx, resolveMachineAdmissionInTx, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readDeploymentArchiveRpcEffectV1 } from '@happier-dev/protocol';
import { isSessionStopChildRootV1, isSessionStopChildV1 } from '@happier-dev/protocol/actions/sessionSections';
import { readSessionAgentReadinessChildActionV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { RequesterSessionCurrentnessPurposeV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { readAdmittedExternalActionHandoffMachineInTx } from '@/app/auth/externalActionHandoffAdmission';
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
                sessionDecision: z.optional(SessionApprovalDecisionCurrentnessV1Schema),
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
        const sessionDecision = request.body.sessionDecision;
        if (sessionDecision) {
            if (purpose || custodySubjectAccountId || workspaceSyncSourceRouting || workspaceSyncTargetRouting || writerRouting
                || callerInputAuthorization || workspaceSyncSourceExecution || workspaceSyncSeedRouting
                || method !== `${sessionDecision.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`
                || context.actorAccountId !== request.userId || context.custodianAccountId !== request.userId
                || context.machineId !== request.params.id || context.role !== 'manage') {
                return reply.code(403).send({ error: 'access_denied' });
            }
            // One Machine read serves the installation proof and the Manage admission.
            const machine = await db.machine.findUnique({ where: { id: request.params.id },
                select: { ...buildMachineAdmissionFactsSelect(request.userId), installationPublicKey: true } });
            if (!machine?.installationPublicKey || machine.accountId !== request.userId
                || machine.installationId !== context.installationId || classifyMachineAvailabilityState(machine) !== 'available'
                || !verifyMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                    installationId: context.installationId, accountId: request.userId, rpcAdmission: { context, method, sessionDecision } },
                    proof, publicKey: encodeBase64(machine.installationPublicKey, 'base64url') })) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const current = await resolveMachineAdmissionFromFactsInTx(db, machine,
                { actorAccountId: request.userId, machineId: machine.id, requiredRole: 'manage' });
            if (current.kind !== 'admitted') return reply.code(403).send({ error: 'access_denied' });
            const session = await db.session.findUnique({ where: { id: sessionDecision.sessionId }, select: { accountId: true } });
            // A Manage admission of this Machine also decides the committed placement's (Use) admission.
            const committedTarget = await readCurrentCommittedSessionInputMachineTargetInTx(db, sessionDecision.sessionId, { admitted: current });
            const currentSessionMachineId = committedTarget?.accountId === request.userId
                ? committedTarget.machineId
                : await app.resolveCurrentSessionMachine?.({ accountId: request.userId, sessionId: sessionDecision.sessionId });
            if (current.installationId !== context.installationId
                || current.encryptionMode !== context.encryptionMode || session?.accountId !== request.userId
                || currentSessionMachineId !== machine.id) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            // Reuse the deciding credential's exact evidence; the canonical Team
            // qualifier checks the referenced authentication methods again.
            const access = await resolveSessionAccessForOperation(db, { accountId: sessionDecision.actor.accountId,
                sessionId: sessionDecision.sessionId, capability: 'submitAgentInput', authentication: {
                    env: process.env, authority: 'present_user', tokenEpoch: sessionDecision.authentication.tokenEpoch,
                    authenticationEvidence: sessionDecision.authentication.evidence?.evidence,
                } });
            const relationship = access.status === 'allowed' && access.access.level === 'owner' ? 'owner' : 'sharedApprover';
            if (access.status !== 'allowed' || relationship !== sessionDecision.actor.relationship) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            return reply.send({ v: 1, ok: true });
        }
        if (workspaceSyncSourceExecution?.originalActionEnvelope || workspaceSyncSourceExecution?.externalActionExecution.deploymentChildExecution) {
            const packet = workspaceSyncSourceExecution;
            const archiveMethod = packet.externalActionExecution.deploymentChildExecution
                ? readDeploymentArchiveRpcEffectV1(method.slice(method.indexOf(':') + 1)) : null;
            if (!callerInputAuthorization || !(callerInputAuthorization.binding.actionId === 'projects.service.relocate'
                || readSessionAgentReadinessChildActionV1(callerInputAuthorization.binding,
                    packet.externalActionExecution.reviewedChild, context) === packet.externalActionExecution.effectActionId
                || (callerInputAuthorization.binding.deploymentChildRoot === true)
                    && (packet.externalActionExecution.deploymentChildRouting !== undefined
                        && method === `${request.params.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}` || archiveMethod !== null)
                || callerInputAuthorization.binding.actionId === 'discussion.second_opinion.start'
                    && packet.externalActionExecution.effectActionId === 'session.spawn_new'
                    && (method === `${request.params.id}:${RPC_METHODS.SESSION_SPAWN_NEW}`
                      || method === `${request.params.id}:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)
                || isSessionStopChildRootV1(callerInputAuthorization.binding.actionId)
                    && method === `${request.params.id}:${RPC_METHODS.STOP_SESSION}`
                    && isSessionStopChildV1({ rootActionId: callerInputAuthorization.binding.actionId,
                        effectActionId: packet.externalActionExecution.effectActionId, method: RPC_METHODS.STOP_SESSION,
                        target: packet.externalActionExecution.target, params: packet.params }))
                || !isDeepStrictEqual(packet.externalActionExecution.authorization, callerInputAuthorization)
                || packet.method !== method || !method.startsWith(`${request.params.id}:`)
                || context.machineId !== request.params.id
                || purpose || custodySubjectAccountId || workspaceSyncSourceRouting || workspaceSyncTargetRouting || writerRouting || workspaceSyncSeedRouting) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const receiver = await db.machine.findUnique({ where: { id: request.params.id },
                select: { ...buildMachineAdmissionFactsSelect(context.actorAccountId), installationPublicKey: true } });
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
            if (child && child.routing.kind !== 'prepare' && child.routing.kind !== 'review' && child.routing.kind !== 'domainDiscover'
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
            const receivingMachineAdmission = signer.id === destination.id ? await resolveReceivingMachineRpcAdmission({
                actorAccountId: admitted.verified.binding.accountId, rpcMethod: method.slice(method.indexOf(':') + 1),
                receiver: { machineId: destination.id, installationId: destination.installationId },
                admitted: admitted.receivingMachineAdmission }) : null;
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
            const writer = await db.machine.findUnique({ where: { id: request.params.id } });
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
                    workspaceSyncSourceRouting, workspaceSyncSourceExecution, app.resolveCurrentSessionMachine)
                : await readCurrentWorkspaceSyncProjectSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting,
                    method.slice(0, method.indexOf(':')), app.resolveCurrentSessionMachine);
            if (!admitted || workspaceSyncSourceExecution && (admitted.route.parentMachineId !== writer.id
                || admitted.route.parentInstallationId !== writer.installationId
                || admitted.route.custodianAccountId !== writer.accountId)) {
                return reply.code(403).send({ error: 'access_denied' });
            }
            const destination = await db.machine.findUnique({ where: { id: admitted.route.parentMachineId } });
            if (!destination?.installationId || !destination.installationPublicKey
                || destination.installationId !== admitted.route.parentInstallationId
                || classifyMachineAvailabilityState(destination) !== 'available') return reply.code(403).send({ error: 'access_denied' });
            const receivingMachineAdmission = await resolveReceivingMachineRpcAdmission({
                actorAccountId: admitted.verified.binding.accountId, rpcMethod: method.slice(method.indexOf(':') + 1),
                receiver: { machineId: destination.id, installationId: destination.installationId },
                admitted: admitted.receivingMachineAdmission });
            return reply.send({ v: 1, ok: true, ...(receivingMachineAdmission ? { receivingMachineAdmission } : {}),
                destinationInstallation: { machineId: destination.id,
                installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
        }
        if (writerRouting) {
            const cleanup = isWorkspaceSyncSourceWriterCleanupPhaseV1(writerRouting.target.phase);
            const retirement = callerInputAuthorization && (writerRouting.target.phase === 'inspect' || writerRouting.target.phase === 'remove')
                ? await readCurrentWorkspaceSyncCopyRetirementAuthorization(callerInputAuthorization, writerRouting, app.resolveCurrentSessionMachine) : null;
            if (purpose || custodySubjectAccountId || workspaceSyncSourceRouting
                || writerRouting.source.accountServerId !== await getOrCreateServerIdentityId()
                || method.slice(method.indexOf(':') + 1) !== readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)
                || (cleanup ? Boolean(workspaceSyncTargetRouting || workspaceSyncSourceExecution)
                    || (callerInputAuthorization ? !retirement : writerRouting.target.phase === 'remove') : !callerInputAuthorization)) {
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
            if (cleanup) {
                // The receiver's existing retained operation owns past target custody.
                // This Home proof authenticates only current writer/receiver transport.
                const { kind: _kind, ...transport } = writer;
                if (!isDeepStrictEqual(context, transport)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                if (receiver.id === writer.machineId
                    && receiver.installationId === writer.installationId) {
                    // SOURCE discovers only transport; the retained TARGET owner
                    // still decides whether this exact copy may be inspected.
                    const destination = await db.machine.findUnique({ where: { id: method.slice(0, method.indexOf(':')) } });
                    if (!destination?.installationId || !destination.installationPublicKey
                        || classifyMachineAvailabilityState(destination) !== 'available') {
                        return reply.code(403).send({ error: 'access_denied' });
                    }
                    return reply.send({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                        installationId: destination.installationId, installationPublicKey: encodeBase64(destination.installationPublicKey, 'base64url') } });
                }
                if (method !== `${receiver.id}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`) {
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
                if (method !== `${route.parentMachineId}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`
                    || (receiver.id === target.machineId ? receiver.installationId !== target.installationId
                        : receiver.id !== route.parentMachineId || receiver.installationId !== route.parentInstallationId)) {
                    return reply.code(403).send({ error: 'access_denied' });
                }
                destinationId = route.parentMachineId;
                destinationInstallationId = route.parentInstallationId;
            } else if (receiver.id !== writer.machineId || receiver.installationId !== writer.installationId
                || method !== `${target.machineId}:${readWorkspaceSyncTargetMethodV1(writerRouting.target.phase)}`
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
        if (callerInputAuthorization && (!workspaceSyncSourceRouting
            || !await verifyWorkspaceSyncHandoffSourceAuthorization(callerInputAuthorization, workspaceSyncSourceRouting, app.resolveCurrentSessionMachine))) {
            return reply.code(403).send({ error: 'access_denied' });
        }
        const current = callerInputAuthorization?.binding.handoffAdmission
            ? await readAdmittedExternalActionHandoffMachineInTx(db, callerInputAuthorization.binding, context.machineId, context)
            : await resolveMachineAdmission({ actorAccountId: isWorkspaceSyncChildRelease
            ? context.custodianAccountId : context.actorAccountId,
            ...requester,
            machineId: context.machineId,
            operationRpcMethod: method.slice(prefix.length),
            ...(isRequesterSessionCurrentness ? { actionId: 'session.open' } : {}),
            ...(isWorkspaceSyncChild || isRequesterSessionCurrentness ? { requiredRole: 'use' as const } : { rpcMethod: method.slice(prefix.length) }) });
        if (!current || current.kind !== 'admitted'
            || current.custodianAccountId !== context.custodianAccountId
            || current.installationId !== context.installationId
            || current.encryptionMode !== context.encryptionMode
            || ((isRequesterSessionCurrentness || isWorkspaceSyncChild && !isWorkspaceSyncChildRelease)
                && context.role === 'manage' && current.role !== 'manage')) {
            return refuse('machine_admission');
        }
        if (purpose) {
            const sessionCurrent = await inTx(async tx => {
                if (!await hasCurrentSessionScopedMachineAccessInTx({ tx,
                    accountId: context.actorAccountId, machineId: context.machineId, sessionId: purpose.sessionId })) return false;
                const final = await resolveMachineAdmissionInTx(tx, { actorAccountId: context.actorAccountId,
                    ...requester,
                    machineId: context.machineId, requiredRole: context.role, actionId: 'session.open' });
                return final.kind === 'admitted' && final.custodianAccountId === context.custodianAccountId
                    && final.installationId === context.installationId && final.encryptionMode === context.encryptionMode;
            });
            if (!sessionCurrent) return refuse('session_binding');
        }
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
        if (callerInputAuthorization && !await hasCurrentExternalActionSessionSource(callerInputAuthorization.binding,
            app.resolveCurrentSessionMachine)) return reply.code(403).send({ error: 'access_denied' });
        return reply.send({ v: 1, ok: true });
    });
}
