import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from 'zod';
import type { Fastify } from "@/app/api/types";
import { resolveMachineAdmissionInTx, resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import {
    ManagedAdmissionInputV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControllerCurrentInputV1Schema,
    ManagedControllerReportV1Schema, ManagedEnrollmentCorrelationV1Schema,
    ManagedControllerContextInputV1Schema, ManagedBootstrapCredentialCreateV1Schema,
    ManagedControllerSubmitInputV1Schema,
    ManagedControllerMachineOutputV1Schema,
    resolveManagedAcquireReviewV1,
    ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1,
    managedMachineActionEndpointPathV1,
    ManagedControlAdmissionInputV1Schema, ManagedControllerIntentReportV1Schema, MANAGED_CONTROL_ACTION_IDS_V1,
    MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    verifyMachineInstallationProof, encodeBase64,
    ManagedGuestCurrentInputV1Schema, ManagedGuestCurrentOutputV1Schema,
    ManagedWakeTargetsReadRequestV1Schema, ManagedWakeTargetsReadResultV1Schema,
    ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema, MANAGED_POLICY_PROOF_HEADER,
    decodeManagedPolicyProofV1, managedPolicyDigestV1, managedPolicyPurposeDigestV1,
    ManagedPolicyCensusInputV1Schema, ManagedPolicyCensusOutputV1Schema,
    ManagedPendingActivationFailureRequestV1Schema, PendingActivationFailureResponseV1Schema,
    MachineEnvironmentApplyInputV1Schema, MachineEnvironmentResolveResultV1Schema, MachineEnvironmentReportInputV1Schema,
} from "@happier-dev/protocol";
import { inTx } from "@/storage/inTx";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";
import { admitManagedAcquire } from "./managedAcquire";
import { submitManagedAcquire, reportManagedAcquire, createManagedBootstrapCredential, requireManagedEnrollmentInTx, admitManagedControl, submitManagedIntent, reportManagedIntent, admitManagedPolicy, prepareManagedPolicy, requireManagedPolicyPurposeInTx } from "./managedMutations";
import { ManagedMachineError, readManagedMachineInTx, requireCurrentManagedMachineInTx, projectManagedMachineInTx, requireManagedControllerInTx, sameManagedInput, readManagedCurrentRequestId } from "./managedRows";
import { getManagedMachine, listManagedMachines, cancelManagedCreation } from "./managedRead";
import { readManagedWakeTargets } from './managedWake';
import { markPendingActivationFailed } from '@/app/session/pending/pendingMessageService';
import { emitPendingChanged } from '@/app/session/pending/publishPendingMutation';
import { resolveMachineEnvironment, reportMachineEnvironment, skipManagedMachineSetup } from './machineEnvironment';

type ControllerProof = Pick<FastifyRequest, "userId" | "externalActionExecutionAuthorized" | "externalActionExecutionMachineId" | "externalActionEffectActionId" | "externalActionExecutionRequestId" | "externalActionExecutionCustodianAccountId">;
export function requireManagedControllerProof(request: ControllerProof, controllerMachineId: string, effects: readonly string[]): Readonly<{ requestId: string; custodianAccountId: string }> {
    if (request.externalActionExecutionAuthorized !== true
        || request.externalActionExecutionMachineId !== controllerMachineId
        || !request.externalActionExecutionRequestId
        || !request.externalActionExecutionCustodianAccountId
        || !effects.includes(request.externalActionEffectActionId ?? "")) throw new ManagedMachineError("permission_denied");
    return { requestId: request.externalActionExecutionRequestId, custodianAccountId: request.externalActionExecutionCustodianAccountId };
}
const effects = ["machines.managed.acquire", "machines.managed.inspect", "machines.managed.bootstrap.retry", "machines.managed.cancel", ...MANAGED_CONTROL_ACTION_IDS_V1];
function managedRequestAuthority(request: FastifyRequest): 'creation' | 'intent' {
    return request.externalActionEffectActionId === 'machines.managed.acquire' || request.externalActionEffectActionId === 'machines.managed.bootstrap.retry'
        ? 'creation' : 'intent';
}
/** Same installation identity authenticates policy-owned HTTP effects; it never mints a public Action envelope. */
export async function requireManagedPolicyRequest(request: FastifyRequest, path: string, input: Readonly<{ homeId: string; managedId: string }>, phase: 'admit' | 'current' | 'submit' | 'report' | 'read' | 'activation-failure') {
    const raw = request.headers[MANAGED_POLICY_PROOF_HEADER];
    if (typeof raw !== 'string') throw new ManagedMachineError('permission_denied');
    const carrier = decodeManagedPolicyProofV1(raw);
    if (!carrier?.payload.managedPolicy) throw new ManagedMachineError('permission_denied');
    return inTx(async tx => {
        const row = await readManagedMachineInTx(tx, input);
        const binding = carrier.payload.managedPolicy!;
        const machine = await projectManagedMachineInTx(tx, row);
        const nativeTarget = machine.resource ?? (carrier.purpose.kind === 'creation-cleanup' && machine.allocation === 'may-exist'
            ? machine.nativeOperationRef : undefined);
        const pending = machine.submittedNativeEffect;
        const currentSigner = carrier.payload.machineId === row.controllerMachineId && carrier.payload.installationId === row.controllerInstallationId
            && binding.expectedIntentRevision === row.intentRevision && binding.controller.machineId === row.controllerMachineId
            && binding.controller.installationId === row.controllerInstallationId;
        const submittedSigner = phase === 'report' && pending && carrier.payload.machineId === pending.controller.machineId
            && carrier.payload.installationId === pending.controller.installationId && binding.expectedIntentRevision === pending.intentRevision
            && binding.requestId === pending.requestId && sameManagedInput(binding.controller, pending.controller);
        const acceptedSource = carrier.purpose.kind === 'accepted-input-start' ? carrier.purpose.target : undefined;
        const activationFailureSigner = phase === 'activation-failure' && acceptedSource
            && acceptedSource.homeId === row.homeId && acceptedSource.managedId === row.id && acceptedSource.enrolledMachineId === row.enrolledMachineId
            && carrier.payload.machineId === acceptedSource.controller.machineId && carrier.payload.installationId === acceptedSource.controller.installationId
            && binding.expectedIntentRevision === acceptedSource.expectedIntentRevision && sameManagedInput(binding.controller, acceptedSource.controller);
        const controller = await tx.machine.findUnique({ where: { id: carrier.payload.machineId } });
        if (request.userId !== row.custodianAccountId || carrier.payload.accountId !== row.custodianAccountId
            || !(currentSigner || submittedSigner || activationFailureSigner) || binding.homeId !== row.homeId || binding.managedId !== row.id
            || binding.purpose !== carrier.purpose.kind || binding.purposeDigest !== managedPolicyPurposeDigestV1(carrier.purpose, carrier.actionOrigin)
            || binding.method !== 'POST' || binding.path !== path || binding.bodyDigest !== managedPolicyDigestV1('body', request.body)
            || !nativeTarget || binding.resourceDigest !== managedPolicyDigestV1('resource', nativeTarget)
            || !controller?.installationPublicKey || !verifyMachineInstallationProof({ payload: carrier.payload, proof: carrier.proof, publicKey: controller.installationPublicKey })) throw new ManagedMachineError('permission_denied');
        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
            controller: { machineId: carrier.payload.machineId, installationId: carrier.payload.installationId } });
        if (phase === 'current' || phase === 'submit') {
            if (binding.requestId !== readManagedCurrentRequestId(row)) throw new ManagedMachineError('request_conflict');
            const currentInput = phase === 'current' ? ManagedControllerCurrentInputV1Schema.parse(request.body) : undefined;
            if (!((currentInput?.nativeRole === 'inspect' || phase === 'submit') && machine.submittedNativeEffect)) {
                await requireManagedPolicyPurposeInTx(tx, row, carrier.purpose, { actionOrigin: carrier.actionOrigin });
            }
        }
        return { carrier, custodianAccountId: row.custodianAccountId };
    });
}
async function respond(reply: FastifyReply, execute: () => Promise<unknown>) {
    try { return reply.send(await execute()); }
    catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return reply.code(error.code === "permission_denied" ? 403 : error.code === "managed_not_found" ? 404 : 409).send({ code: error.code });
    }
}

/** Internal controller transitions consume the existing signed Action HTTP authority. */
export function registerManagedMachineRoutes(app: Fastify): void {
    app.post('/v1/machines/environment/resolve', { preHandler: app.authenticate,
        schema: { body: MachineEnvironmentApplyInputV1Schema, response: { 200: MachineEnvironmentResolveResultV1Schema } } },
        async (request, reply) => respond(reply, async () => {
            const { custodianAccountId } = requireManagedControllerProof(request, request.body.machineId, ['machines.environment.apply']);
            return resolveMachineEnvironment({ actorAccountId: request.userId, custodianAccountId,
                authentication: readTeamOperationAuthenticationFromRequest(request), input: request.body,
                creationManagedId: request.externalActionExecutionAuthorizationBinding?.managedContinuation?.managedId });
        }));
    app.post('/v1/machines/environment/report', { preHandler: app.authenticate,
        schema: { body: MachineEnvironmentReportInputV1Schema, response: { 200: ManagedControllerMachineOutputV1Schema } } },
        async (request, reply) => respond(reply, async () => {
            const { custodianAccountId } = requireManagedControllerProof(request, request.body.machineId, ['machines.environment.apply']);
            return reportMachineEnvironment({ actorAccountId: request.userId, custodianAccountId, input: request.body,
                creationManagedId: request.externalActionExecutionAuthorizationBinding?.managedContinuation?.managedId });
        }));
    app.post(managedMachineActionEndpointPathV1('machines.managed.setup.skip'), { preHandler: app.authenticate,
        schema: { body: ManagedMachineActionInputSchemasV1['machines.managed.setup.skip'],
            response: { 200: ManagedMachineActionOutputSchemasV1['machines.managed.setup.skip'] } } },
        async (request, reply) => respond(reply, () => skipManagedMachineSetup({ actorAccountId: request.userId, input: request.body })));
    app.post('/v1/machines/managed/controller/policies', { preHandler: app.authenticate, schema: { body: ManagedPolicyCensusInputV1Schema, response: { 200: ManagedPolicyCensusOutputV1Schema } } }, async (request, reply) => respond(reply, async () => {
        const { homeId, controller, proof } = request.body;
        const machines = await inTx(async tx => {
            await requireManagedControllerInTx(tx, { homeId, controller, custodianAccountId: request.userId });
            const current = await tx.machine.findUniqueOrThrow({ where: { id: controller.machineId } });
            if (!current.installationPublicKey || !verifyMachineInstallationProof({ payload: { version: 1, machineId: controller.machineId,
                installationId: controller.installationId, accountId: request.userId, managedPolicyCensus: { homeId } }, proof,
                publicKey: current.installationPublicKey })) throw new ManagedMachineError('permission_denied');
            const rows = await tx.managedMachine.findMany({ where: { homeId, custodianAccountId: request.userId,
                controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
                archivedAt: null, OR: [{ allocation: 'bound', creationState: 'active' },
                    { allocation: { in: ['bound', 'may-exist'] }, creationState: 'canceled', desired: 'delete', desiredWhen: 'now' }] } });
            return Promise.all(rows.map(row => projectManagedMachineInTx(tx, row)));
        });
        const { targets } = await readManagedWakeTargets({ actorAccountId: request.userId, request: { homeId, controller } });
        return { machines, targets };
    }));
    app.post('/v1/machines/managed/controller/prepare-policy', { preHandler: app.authenticate, schema: { body: ManagedPolicyAdmissionInputV1Schema, response: { 200: ManagedControllerMachineOutputV1Schema } } }, async (request, reply) => respond(reply, async () => {
        const verified = await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/prepare-policy', request.body, 'admit');
        if (!sameManagedInput(verified.carrier.purpose, request.body.purpose)
            || verified.carrier.payload.managedPolicy?.requestId !== request.body.requestId) throw new ManagedMachineError('permission_denied');
        return prepareManagedPolicy({ custodianAccountId: verified.custodianAccountId, input: request.body, actionOrigin: verified.carrier.actionOrigin });
    }));
    app.post('/v1/machines/managed/controller/admit-policy', { preHandler: app.authenticate, schema: { body: ManagedPolicyAdmissionInputV1Schema, response: { 200: ManagedPolicyAdmissionOutputV1Schema } } }, async (request, reply) => respond(reply, async () => {
        const verified = await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/admit-policy', request.body, 'admit');
        if (!sameManagedInput(verified.carrier.purpose, request.body.purpose)
            || verified.carrier.payload.managedPolicy?.requestId !== request.body.requestId) throw new ManagedMachineError('permission_denied');
        return admitManagedPolicy({ custodianAccountId: verified.custodianAccountId, input: request.body, actionOrigin: verified.carrier.actionOrigin });
    }));
    app.post('/v1/machines/managed/controller/wake-targets', { preHandler: app.authenticate,
        schema: { body: ManagedWakeTargetsReadRequestV1Schema, response: { 200: ManagedWakeTargetsReadResultV1Schema } } },
        async (request, reply) => respond(reply, () => readManagedWakeTargets({ actorAccountId: request.userId, request: request.body })));
    app.post('/v1/machines/managed/controller/activation-failed', { preHandler: app.authenticate,
        schema: { body: ManagedPendingActivationFailureRequestV1Schema, response: {
            200: PendingActivationFailureResponseV1Schema,
            400: z.object({ error: z.string() }).passthrough(),
            403: z.union([z.object({ error: z.string() }).passthrough(), z.object({ code: z.string() }).strict()]),
            404: z.union([z.object({ error: z.string() }).passthrough(), z.object({ code: z.string() }).strict()]),
            409: z.object({ code: z.string() }).strict(),
            500: z.object({ error: z.string() }).passthrough(),
        } } },
        async (request, reply) => respond(reply, async () => {
            const verified = await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/activation-failed', request.body.target, 'activation-failure');
            if (verified.carrier.purpose.kind !== 'accepted-input-start'
                || !sameManagedInput(verified.carrier.purpose.target, request.body.target)) throw new ManagedMachineError('permission_denied');
            const target = verified.carrier.purpose.target;
            if (target.origin.kind !== 'session-input') throw new ManagedMachineError('permission_denied');
            const result = await markPendingActivationFailed({ actorUserId: request.userId,
                sessionId: target.origin.session.sessionId, requestId: target.origin.pendingRequestId,
                requestedAt: target.origin.requestedAt, failureCode: request.body.failureCode,
                managedController: { target, custodianAccountId: verified.custodianAccountId } });
            if (!result.ok) return reply.code(result.error === 'session-not-found' ? 404
                : result.error === 'forbidden' ? 403 : result.error === 'invalid-params' ? 400 : 500).send({ error: result.error });
            if (result.didFail) await emitPendingChanged({ sessionId: target.origin.session.sessionId,
                changedByAccountId: request.userId, pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount, pendingVersion: result.pendingVersion,
                recipientCursors: result.recipientCursors });
            return { ok: true, didFail: result.didFail };
        }));
    app.post('/v1/machines/managed/guest/current', { preHandler: app.authenticate, schema: { body: ManagedGuestCurrentInputV1Schema, response: { 200: ManagedGuestCurrentOutputV1Schema } } }, async (request, reply) => respond(reply, async () => inTx(async tx => {
        const { context, method, managedTarget, proof } = request.body;
        const rpcMethod = method.slice(`${context.machineId}:`.length);
        if (request.userId !== context.custodianAccountId || !method.startsWith(`${context.machineId}:`)
            || ![MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD].includes(rpcMethod)) throw new ManagedMachineError('permission_denied');
        const guest = await tx.machine.findUnique({ where: { id: context.machineId } });
        if (!guest || guest.accountId !== context.custodianAccountId || guest.installationId !== context.installationId
            || !guest.installationPublicKey || classifyMachineAvailabilityState(guest) !== 'available'
            || !verifyMachineInstallationProof({ payload: { version: 1, machineId: context.machineId, installationId: context.installationId,
                accountId: context.custodianAccountId, rpcAdmission: { context, method, managedTarget } }, proof,
                publicKey: encodeBase64(guest.installationPublicKey, 'base64url') })) throw new ManagedMachineError('permission_denied');
        const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: context.actorAccountId, machineId: context.machineId, rpcMethod });
        if (admission.kind !== 'admitted' || admission.installationId !== context.installationId
            || admission.encryptionMode !== context.encryptionMode || admission.role !== context.role) throw new ManagedMachineError('permission_denied');
        const row = await readManagedMachineInTx(tx, managedTarget);
        if (row.custodianAccountId !== context.custodianAccountId || row.enrolledMachineId !== context.machineId
            || row.intentRevision !== managedTarget.expectedRevision || row.controllerMachineId !== managedTarget.controller.machineId
            || row.controllerInstallationId !== managedTarget.controller.installationId || row.creationState !== 'active'
            || row.archivedAt !== null) return { current: false };
        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: managedTarget.controller });
        if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: context.actorAccountId, machineId: row.controllerMachineId }) !== 'manage') throw new ManagedMachineError('permission_denied');
        return { current: true };
    })));
    app.post("/v1/machines/managed/controller/admit-control", { preHandler: app.authenticate, schema: { body: ManagedControlAdmissionInputV1Schema } }, async (request, reply) => respond(reply, async () => {
        const input = request.body.input;
        const row = await inTx(tx => readManagedMachineInTx(tx, { homeId: input.homeId,
            managedId: 'managedMachineId' in input ? input.managedMachineId : input.managedId }));
        const executionMachineId = request.body.action === 'machines.managed.controller.update'
            ? request.body.input.controller.machineId : row.controllerMachineId;
        const proof = requireManagedControllerProof(request, executionMachineId, [request.body.action]);
        if (proof.requestId !== request.body.requestId) throw new ManagedMachineError("request_conflict");
        return admitManagedControl({ actorAccountId: request.userId, custodianAccountId: proof.custodianAccountId,
            authentication: readTeamOperationAuthenticationFromRequest(request), input: request.body });
    }));
    app.post("/v1/machines/managed/controller/submit-intent", { preHandler: app.authenticate, schema: { body: ManagedControllerCurrentnessV1Schema } }, async (request, reply) => respond(reply, async () => {
        if (request.headers[MANAGED_POLICY_PROOF_HEADER] !== undefined) await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/submit-intent', request.body, 'submit');
        else requireManagedControllerProof(request, request.body.controller.machineId, effects);
        return submitManagedIntent(request.body);
    }));
    app.post("/v1/machines/managed/controller/report-intent", { preHandler: app.authenticate, schema: { body: ManagedControllerIntentReportV1Schema } }, async (request, reply) => respond(reply, async () => {
        if (request.headers[MANAGED_POLICY_PROOF_HEADER] !== undefined) {
            await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/report-intent', request.body, 'report');
            return reportManagedIntent(request.body);
        }
        const row = await inTx(tx => readManagedMachineInTx(tx, request.body));
        const executor = request.externalActionExecutionMachineId;
        if (executor !== row.controllerMachineId && executor !== request.body.controller.machineId) throw new ManagedMachineError("permission_denied");
        const proof = requireManagedControllerProof(request, executor, effects);
        if (row.custodianAccountId !== proof.custodianAccountId) throw new ManagedMachineError("permission_denied");
        return reportManagedIntent(request.body);
    }));
    app.post(managedMachineActionEndpointPathV1("machines.managed.list"), { preHandler: app.authenticate, schema: { body: ManagedMachineActionInputSchemasV1["machines.managed.list"], response: { 200: ManagedMachineActionOutputSchemasV1["machines.managed.list"] } } }, async (request, reply) => respond(reply, () => listManagedMachines({ actorAccountId: request.userId, input: request.body })));
    app.post(managedMachineActionEndpointPathV1("machines.managed.get"), { preHandler: app.authenticate, schema: { body: ManagedMachineActionInputSchemasV1["machines.managed.get"], response: { 200: ManagedMachineActionOutputSchemasV1["machines.managed.get"] } } }, async (request, reply) => respond(reply, () => getManagedMachine({ actorAccountId: request.userId, input: request.body })));
    app.post(managedMachineActionEndpointPathV1("machines.managed.cancel"), { preHandler: app.authenticate, schema: { body: ManagedMachineActionInputSchemasV1["machines.managed.cancel"], response: { 200: ManagedMachineActionOutputSchemasV1["machines.managed.cancel"] } } }, async (request, reply) => respond(reply, () => cancelManagedCreation({ actorAccountId: request.userId, input: request.body })));
    app.post("/v1/machines/managed/controller/admit", { preHandler: app.authenticate, schema: { body: ManagedAdmissionInputV1Schema } }, async (request, reply) => respond(reply, async () => {
        const { requestId, custodianAccountId } = requireManagedControllerProof(request, resolveManagedAcquireReviewV1(request.body.input).controller.machineId, ["machines.managed.acquire"]);
        if (requestId !== request.body.requestId) throw new ManagedMachineError("request_conflict");
        if (!request.externalActionExecutionRequestEnvelopeDigest) throw new ManagedMachineError("permission_denied");
        return await admitManagedAcquire({ custodianAccountId, requesterAccountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), requestEnvelopeDigest: request.externalActionExecutionRequestEnvelopeDigest, input: request.body });
    }));
    app.post("/v1/machines/managed/controller/context", { preHandler: app.authenticate, schema: { body: ManagedControllerContextInputV1Schema } }, async (request, reply) => respond(reply, async () => {
        const { custodianAccountId } = request.headers[MANAGED_POLICY_PROOF_HEADER] !== undefined
            ? await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/context', request.body, 'read')
            : requireManagedControllerProof(request, request.body.controller.machineId, effects);
        return await inTx(async (tx) => {
            const row = await readManagedMachineInTx(tx, request.body);
            if (row.custodianAccountId !== custodianAccountId) throw new ManagedMachineError("permission_denied");
            const requestAuthority = managedRequestAuthority(request);
            const requestId = requestAuthority === 'creation' ? row.admittedActionRequestId : readManagedCurrentRequestId(row);
            const current = await requireCurrentManagedMachineInTx(tx, { ...request.body, requestId }, { requestAuthority, allowInactiveCurrentIntent: requestAuthority === 'intent' });
            return { machine: await projectManagedMachineInTx(tx, current), requestId };
        });
    }));
    app.post("/v1/machines/managed/controller/current", { preHandler: app.authenticate, schema: { body: ManagedControllerCurrentInputV1Schema } }, async (request, reply) => respond(reply, async () => {
        const { custodianAccountId } = request.headers[MANAGED_POLICY_PROOF_HEADER] !== undefined
            ? await requireManagedPolicyRequest(request, '/v1/machines/managed/controller/current', request.body, 'current')
            : requireManagedControllerProof(request, request.body.controller.machineId, effects);
        return await inTx(async (tx) => {
            const requestAuthority = managedRequestAuthority(request);
            const row = await requireCurrentManagedMachineInTx(tx, request.body, { requestAuthority, allowInactiveCurrentIntent: requestAuthority === 'intent' });
            if (row.custodianAccountId !== custodianAccountId) throw new ManagedMachineError("permission_denied");
            return { machine: await projectManagedMachineInTx(tx, row) };
        });
    }));
    app.post("/v1/machines/managed/controller/submit", { preHandler: app.authenticate, schema: { body: ManagedControllerSubmitInputV1Schema } }, async (request, reply) => respond(reply, async () => {
        requireManagedControllerProof(request, request.body.controller.machineId, ["machines.managed.acquire", "machines.managed.bootstrap.retry"]);
        return await submitManagedAcquire(request.body);
    }));
    app.post("/v1/machines/managed/controller/report", { preHandler: app.authenticate, schema: { body: ManagedControllerReportV1Schema } }, async (request, reply) => respond(reply, async () => {
        requireManagedControllerProof(request, request.body.controller.machineId, effects);
        return await reportManagedAcquire(request.body, { requestAuthority: managedRequestAuthority(request) });
    }));
    app.post("/v1/machines/managed/controller/create-bootstrap-credential", { preHandler: app.authenticate, schema: { body: ManagedBootstrapCredentialCreateV1Schema } }, async (request, reply) => respond(reply, async () => {
        requireManagedControllerProof(request, request.body.controller.machineId, ["machines.managed.acquire", "machines.managed.bootstrap.retry"]);
        return await createManagedBootstrapCredential(request.body);
    }));
    app.post("/v1/machines/managed/controller/enrollment-context", { preHandler: app.authenticate, schema: { body: ManagedEnrollmentCorrelationV1Schema } }, async (request, reply) => respond(reply, async () => {
        const { custodianAccountId } = requireManagedControllerProof(request, request.body.controller.machineId, effects);
        return await inTx(async (tx) => ({ machine: await projectManagedMachineInTx(tx, await requireManagedEnrollmentInTx(tx, request.body, custodianAccountId)) }));
    }));
}
