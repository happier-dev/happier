import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { inTx, type Tx } from '@/storage/inTx';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ManagedCredentialInstallInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { TeamCredentialExecutionRunCurrentnessResolver } from '@/app/teams/credentials/providerBrokerAdmission';
import { admitProviderBrokerConsumerInTx } from '@/app/providers/brokerConsumerAdmission';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { admitTeamCredentialOperationBindingInTx, validateSessionTeamCredentialNativeCensusInTx } from '@/app/teams/credentials/sessionBinding';
import { readSessionTeamCredentialNativeSelectionInTx,
    readSessionTeamCredentialNativeSelectionsForManagedMachineInTx } from '@/app/teams/credentials/nativeDeliveryRead';
import { computeTeamCredentialNativeBindingReadDigestV1, type TeamCredentialNativeBindingReadRequestV1,
    type TeamCredentialNativeBindingReadResponseV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { stampSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';
import type { Fastify } from '@/app/api/types';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { ManagedMachineError, readManagedController, readManagedEnrollmentAccountId, readManagedLaunchSnapshot,
    requireManagedControllerInTx, resolveManagedDeclarationInTx } from './managedRows';

/** Exact placement facts shared by catalog qualification and install admission.
 * The provisioner's demanded runtime check remains a separate required fact. */
export async function readManagedNativeCredentialTargetInTx(tx: Tx, input: Readonly<{
    accountId: string;
    executionMachineId: string;
    resourceCustodianAccountId: string;
    homeId?: string;
}>) {
    const guest = await tx.machine.findUnique({ where: { id: input.executionMachineId }, select: {
        id: true, accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true,
    } });
    if (!guest || !guest.installationId || guest.accountId !== input.accountId
        || classifyMachineAvailabilityState(guest) !== 'available') return null;
    const machine = await tx.managedMachine.findFirst({ where: {
        enrolledMachineId: guest.id, custodianAccountId: input.resourceCustodianAccountId,
        ...(input.homeId ? { homeId: input.homeId } : {}),
        archivedAt: null, allocation: 'bound', creationState: 'active',
    } });
    if (!machine || !machine.resource || machine.desired === 'delete') return null;
    // Native credential apply is a controller daemon effect; an Account-controlled
    // row has no controller and therefore no native delivery target.
    const controller = readManagedController(machine);
    if (!controller) return null;
    try {
        if (readManagedEnrollmentAccountId(machine) !== input.accountId) return null;
        await requireManagedControllerInTx(tx, { homeId: machine.homeId, custodianAccountId: machine.custodianAccountId,
            controller });
        const declaration = await resolveManagedDeclarationInTx(tx, { homeId: machine.homeId,
            custodianAccountId: machine.custodianAccountId, controller,
            provider: readManagedLaunchSnapshot(machine.launch).provider });
        return declaration?.nativeCredentialDelivery ? { machine, controller, declaration,
            guest: { machineId: guest.id, installationId: guest.installationId } } : null;
    } catch (error) {
        if (error instanceof ManagedMachineError) return null;
        throw error;
    }
}

/** Demanded once by the caller's exact-Machine catalog batch or fresh install.
 * A declaration or missing/newer check fact never implies tenant support. */
export async function readManagedNativeCredentialQualification(app: Pick<Fastify, 'forwardRpcForUser'>,
    target: NonNullable<Awaited<ReturnType<typeof readManagedNativeCredentialTargetInTx>>>) {
    const { machine, controller } = target;
    const launch = readManagedLaunchSnapshot(machine.launch);
    const input = ManagedMachineActionInputSchemasV1['machines.provisioners.check'].parse({
        homeId: machine.homeId, controller,
        contribution: launch.provider,
        ...(launch.credentials ? { credentials: launch.credentials } : {}),
    });
    try {
        const response = await app.forwardRpcForUser({ userId: machine.custodianAccountId,
            method: `${controller.machineId}:machines.provisioners.check`, params: input });
        if (!response.ok) return false;
        const checked = MachineProvisionerCheckResultV1Schema.safeParse(response.result);
        return checked.success && checked.data.available
            && checked.data.nativeCredentialDelivery?.status === 'supported';
    } catch { return false; }
}

/** Existing Run-owner evidence, resolved before the authority transaction. */
export type ManagedCredentialConsumerCurrentness = Extract<Awaited<ReturnType<TeamCredentialExecutionRunCurrentnessResolver>>, { ok: true }>
    & Readonly<{ accountId: string; workerMachineId: string; executionRunId: string }>;

export interface ManagedCredentialDeliveryAuthorityInput {
    actorAccountId: string;
    machineId: string;
    request: ManagedCredentialInstallInputV1;
    authentication: SessionAccessAuthentication;
    sessionActionOrigin?: ExternalActionExecutionAuthorizationBindingV1['sessionActionOrigin'];
    sessionActionSource?: ExternalActionExecutionAuthorizationBindingV1['sessionActionSource'];
    managedCredentialConsumer?: ManagedCredentialConsumerCurrentness;
    /** Only a verified incumbent Home execution binding supplies this identity. */
    continuingRequestId?: string;
}

/** Exact accepted authority applies even when the requester owns the controller. */
async function readManagedCredentialDeliveryAuthority(tx: Tx, input: ManagedCredentialDeliveryAuthorityInput, readiness: 'ready' | 'pending' | 'submitted') {
    const request = input.request;
    const stored = await readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: request.sessionId });
    if (!stored.ok || stored.binding.accountId !== input.actorAccountId || readiness !== 'pending' && !stored.binding.delivery) return null;
    const accepted = stored.binding;
    const binding = accepted.safeFacet;
    const executionMachineId = accepted.providerModelSelection.executionMachineId;
    if (!executionMachineId || binding.managedId !== request.managedId || binding.bindingKey !== request.bindingKey
        || binding.sourceRevision !== request.expectedSourceRevision || binding.providerTicket !== request.expectedProviderTicket
        || accepted.resourceRevision !== request.expectedResourceRevision) return null;
    const target = await readManagedNativeCredentialTargetInTx(tx, { accountId: input.actorAccountId,
        executionMachineId, resourceCustodianAccountId: accepted.custodianAccountId,
        homeId: request.homeId });
    if (!target || target.machine.id !== request.managedId || target.machine.controllerMachineId !== input.machineId
        || target.machine.controllerInstallationId !== binding.controllerInstallationId
        || target.guest.installationId !== binding.guestInstallationId) return null;
    if (input.sessionActionOrigin && (input.sessionActionOrigin.caller.sessionId !== request.sessionId
        || input.sessionActionSource?.machineId !== target.guest.machineId
        || input.sessionActionSource.installationId !== target.guest.installationId)) return null;
    // Attached Runs borrow their owning Session's rule; they never retire it.
    if (request.operation === 'release' && request.executionRunId) return null;
    // A terminal report can settle only its already-submitted exact operation.
    // It cannot read material, qualify a new use, or submit another mutation.
    if (readiness === 'submitted') return accepted.submission
        && accepted.submission.requestId === input.continuingRequestId
        && accepted.submission.operation === (request.operation ?? 'install')
        ? { ...target, binding: accepted, admission: null } : null;
    const census = await readSessionTeamCredentialNativeSelectionsForManagedMachineInTx(tx, { managedId: target.machine.id });
    if (!census.ok) return null;
    const eligible = await validateSessionTeamCredentialNativeCensusInTx(tx, {
        accountId: input.actorAccountId, request, censusBindings: census.bindings, authentication: input.authentication,
    });
    if (!eligible.ok) return null;
    // Exact installed lifetime cleanup reduces authority. Revoked consumption,
    // an ended Session or a disabled source must not prevent removing its rule.
    if (request.operation === 'release') {
        if (!accepted.delivery || accepted.installation === 'prepared') return null;
        return { ...target, binding: accepted, admission: null };
    }
    const run = input.managedCredentialConsumer;
    if (request.executionRunId && (!run || run.executionRunId !== request.executionRunId
        || run.parentSessionId !== request.sessionId || run.accountId !== input.actorAccountId
        || run.workerMachineId !== target.guest.machineId
        || run.teamCredentialProviderModel && (run.teamCredentialProviderModel.resourceId !== accepted.resourceId
            || run.teamCredentialProviderModel.deliveryMode !== 'vendor-native'))) return null;
    const consumer = await admitProviderBrokerConsumerInTx(tx, { accountId: input.actorAccountId,
        initiatorMachineId: target.guest.machineId,
        consumer: request.executionRunId ? { kind: 'execution_run', executionRunId: request.executionRunId }
            : { kind: 'session', sessionId: request.sessionId },
        executionRun: request.executionRunId ? run ?? null : null });
    if (!consumer.ok) return null;
    const admission = await admitTeamCredentialOperationBindingInTx(tx, {
        consumer: request.executionRunId
            ? { kind: 'execution_run', parentSessionId: request.sessionId, resourceId: accepted.resourceId }
            : { kind: 'session', sessionId: request.sessionId },
        accountId: input.actorAccountId, slot: { kind: 'provider_model' }, deliveryMode: 'vendor-native',
        expectedResourceRevision: request.expectedResourceRevision, authentication: input.authentication,
    });
    if (!admission.ok || admission.binding.resourceId !== accepted.resourceId
        || admission.custodianAccountId !== target.machine.custodianAccountId) return null;
    return { ...target, binding: accepted, admission };
}

export function readManagedCredentialDeliveryAuthorityInTx(tx: Tx, input: ManagedCredentialDeliveryAuthorityInput) {
    return readManagedCredentialDeliveryAuthority(tx, input, 'ready');
}

/** Private result settlement only; callers must verify the original installed root. */
export function readManagedCredentialDeliverySubmittedAuthorityInTx(tx: Tx, input: ManagedCredentialDeliveryAuthorityInput) {
    return readManagedCredentialDeliveryAuthority(tx, input, 'submitted');
}

/** Initial source preparation consumes the same accepted authority, not Action echoes. */
export function readManagedCredentialDeliveryPendingAuthorityInTx(tx: Tx, input: ManagedCredentialDeliveryAuthorityInput) {
    return readManagedCredentialDeliveryAuthority(tx, input, 'pending');
}

/** Home prepares only an accepted selection, outside its authority transaction.
 * The canonical writer re-derives the selected model/source from this actual
 * authenticated custodian response before final Action admission rereads it. */
export async function prepareManagedCredentialDeliveryForAction(app: Pick<Fastify, 'forwardRpcForUser'>,
    input: ManagedCredentialDeliveryAuthorityInput): Promise<boolean> {
    if (input.request.operation === 'release') return await inTx(tx => readManagedCredentialDeliveryAuthorityInTx(tx, input)) !== null;
    const accepted = await inTx(tx => readManagedCredentialDeliveryPendingAuthorityInTx(tx, input));
    if (!accepted?.admission || !await readManagedNativeCredentialQualification(app, accepted)) return false;
    const binding = accepted.binding;
    const source = accepted.admission.sourceBinding;
    const selection = binding.providerModelSelection;
    if (source.kind !== 'provider_connection' || !selection.application) return false;
    const request = DaemonProviderModelProjectionRequestV1Schema.safeParse({ machineId: accepted.machine.controllerMachineId,
        agentTargetKey: selection.agentTargetKey, application: selection.application, sourceCatalog: true,
        refreshPolicy: 'current_only', currentSelection: { agentTargetKey: selection.agentTargetKey,
            providerConnectionId: source.connectionId, modelId: selection.modelId },
        providerConnection: { connectionId: source.connectionId,
            expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint },
        nativeSource: { resourceId: binding.resourceId, expectedResourceRevision: binding.resourceRevision },
    });
    if (!request.success) return false;
    try {
        const response = await app.forwardRpcForUser({ userId: binding.custodianAccountId,
            method: `${accepted.machine.controllerMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`, params: request.data });
        if (!response.ok) return false;
        const projection = DaemonProviderModelProjectionResponseV1Schema.safeParse(response.result);
        if (!projection.success || projection.data.status !== 'success') return false;
        const stamped = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, {
            sessionId: binding.sessionId, accountId: input.actorAccountId,
            response: projection.data, authentication: input.authentication,
        }));
        return stamped.ok;
    } catch { return false; }
}

/** Native installation never grants controller Use/Manage to its Session owner. */
export async function resolveManagedCredentialDeliveryMachineAdmissionInTx(tx: Tx,
    input: ManagedCredentialDeliveryAuthorityInput & Readonly<{ requireOnline?: boolean;
        /** Private signed-child issuer preparation only, never effect admission. */
        nativeCredentialSpawnPreparation?: true;
    }>) {
    const denied = { kind: 'denied', code: 'access_denied' } as const;
    const current = input.nativeCredentialSpawnPreparation === true
        ? await readManagedCredentialDeliveryPendingAuthorityInTx(tx, input)
        : await readManagedCredentialDeliveryAuthorityInTx(tx, input);
    if (!current) return denied;
    const controller = await resolveMachineAdmissionInTx(tx, { actorAccountId: current.machine.custodianAccountId,
        callerAuthority: input.authentication.authority, machineId: input.machineId,
        actionId: 'machines.managed.credentials.install', requiredRole: 'manage',
        ...(input.requireOnline === undefined ? {} : { requireOnline: input.requireOnline }) });
    return controller.kind === 'admitted' && controller.installationId === current.machine.controllerInstallationId
        ? { ...controller, actorAccountId: input.actorAccountId } : denied;
}

/** Same-row private borrow; it never probes a controller or materializes a source. */
export async function readManagedNativeCredentialBindingForGuestInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; homeId: string; request: TeamCredentialNativeBindingReadRequestV1;
    authentication: SessionAccessAuthentication;
}>): Promise<TeamCredentialNativeBindingReadResponseV1> {
    const unavailable = { status: 'unavailable', reason: 'binding_unavailable' } as const;
    const { proof, ...request } = input.request;
    if (request.homeId !== input.homeId) return unavailable;
    const guest = await tx.machine.findUnique({ where: { id: request.machineId } });
    if (!guest || guest.accountId !== input.actorAccountId || guest.installationId !== request.installationId
        || !guest.installationPublicKey || classifyMachineAvailabilityState(guest) !== 'available'
        || !verifyMachineInstallationProof({ payload: { version: 1, accountId: input.actorAccountId,
            machineId: request.machineId, installationId: request.installationId,
            nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(request) } },
            proof, publicKey: guest.installationPublicKey })) return unavailable;
    const stored = await readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: request.sessionId });
    if (!stored.ok || stored.binding.accountId !== input.actorAccountId
        || stored.binding.resourceId !== request.resourceId || stored.binding.resourceRevision !== request.expectedResourceRevision
        || stored.binding.providerModelSelection.executionMachineId !== request.machineId) return unavailable;
    const accepted = stored.binding;
    const facet = accepted.safeFacet;
    if (facet.managedId !== request.managedId || facet.bindingKey !== request.bindingKey
        || facet.guestInstallationId !== request.installationId || facet.sourceRevision !== request.expectedSourceRevision
        || facet.providerTicket !== request.expectedProviderTicket) return unavailable;
    const target = await readManagedNativeCredentialTargetInTx(tx, { accountId: input.actorAccountId,
        executionMachineId: request.machineId, resourceCustodianAccountId: accepted.custodianAccountId, homeId: input.homeId });
    if (!target || target.machine.id !== facet.managedId
        || target.machine.controllerInstallationId !== facet.controllerInstallationId) return unavailable;
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: request.resourceId }, select: { teamId: true } });
    if (resource?.teamId !== request.teamId) return unavailable;
    // This exact owning guest may inspect a no-effect birth after USE ends;
    // material disclosure below still requires current Session and Team admission.
    if (accepted.installation === 'prepared') return { status: 'prepared', binding: facet };
    const consumer = await admitProviderBrokerConsumerInTx(tx, { accountId: input.actorAccountId,
        initiatorMachineId: request.machineId, consumer: { kind: 'session', sessionId: request.sessionId }, executionRun: null });
    if (!consumer.ok) return unavailable;
    const admission = await admitTeamCredentialOperationBindingInTx(tx, {
        consumer: { kind: 'session', sessionId: request.sessionId }, accountId: input.actorAccountId,
        slot: { kind: 'provider_model' }, deliveryMode: 'vendor-native',
        expectedResourceRevision: request.expectedResourceRevision, authentication: input.authentication,
    });
    if (!admission.ok || admission.binding.resourceId !== request.resourceId
        || admission.custodianAccountId !== accepted.custodianAccountId) return unavailable;
    if (!accepted.delivery) return unavailable;
    return { status: 'ready', binding: facet, model: accepted.delivery.model, endpoint: accepted.delivery.endpoint,
        credentialTransport: accepted.delivery.credentialTransport, placeholder: accepted.delivery.placeholder };
}
