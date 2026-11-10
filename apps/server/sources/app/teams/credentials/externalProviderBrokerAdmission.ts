import { TeamCredentialExternalProviderAdmissionV1Schema, TeamCredentialExternalProviderTerminalUsageV1Schema, TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema, type TeamCredentialExternalProviderAdmissionV1, type TeamCredentialExternalProviderAdmissionResponseV1, type TeamCredentialExternalProviderTerminalUsageResponseV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';

import type { Tx } from '@/storage/inTx';
import { admitTeamCredentialBrokerMachineForResourceInTx, resolveTeamCredentialBrokerPlacementFingerprint } from './brokerPlacementResolver';
import { readExternalBrokerOperation } from './externalBrokerOperation';
import { resolveTeamCredentialResourceSourceInTx } from './resourceSourceResolver';
import { admitTeamCredentialUsageInTx } from './teamCredentialUsageAdmission';
import { recordTeamCredentialExternalTerminalUsageEventInTx } from '@/app/usage/usageWriteService';
import { resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx } from './externalApiKey';

type ExternalAdmissionFailure = Extract<TeamCredentialExternalProviderAdmissionResponseV1, { ok: false }>;
const failure = (
    reasonCode: ExternalAdmissionFailure['reasonCode'],
    usageLimit?: ExternalAdmissionFailure['usageLimit'],
): ExternalAdmissionFailure => ({ ok: false, reasonCode, ...(usageLimit ? { usageLimit } : {}) });

async function authorizeCurrentExternalProviderKeyInTx(
    tx: Tx,
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        binding: Extract<TeamCredentialExternalProviderAdmissionV1['binding'], { kind: 'external_api_key' }>;
        brokerMachineId: string;
        expectedResourceRevision: number;
        observedAt: Date;
    }>,
) {
    const { binding, brokerMachineId, expectedResourceRevision } = input;
    const key = await resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx(tx, {
        kind: 'admitted_key',
        keyId: binding.externalApiKeyId,
    }, input.observedAt);
    if (!key.ok) return failure(key.reason);
    if (key.resourceId !== binding.resourceId || key.teamId !== binding.teamId
        || key.assignedTeamMembershipId !== binding.assignedTeamMembershipId
        || key.assignedAccountId !== binding.assignedAccountId) return failure('operation_not_current');
    if (key.custodianAccountId !== input.authenticatedBrokerAccountId) return failure('resource_forbidden');
    if (key.resourceRevision !== expectedResourceRevision) return failure('resource_changed');
    const resource = {
        id: key.resourceId,
        teamId: key.teamId,
        custodianAccountId: key.custodianAccountId,
        revision: key.resourceRevision,
        brokerMachineId: key.brokerMachineId,
        brokerPoolId: key.brokerPoolId,
        sourceBindingJson: key.sourceBindingJson,
    };
    if (binding.brokerPlacementFingerprint !== resolveTeamCredentialBrokerPlacementFingerprint(resource)) {
        return failure('operation_not_current');
    }
    const operation = key.currentBrokerOperationJson === null
        ? null : readExternalBrokerOperation(key.currentBrokerOperationJson);
    if (binding.operationId === null) {
        if (key.currentBrokerOperationJson !== null) return failure('operation_not_current');
    } else {
        if (!operation || operation.operationId !== binding.operationId
            || operation.brokerMachineId !== brokerMachineId
            || operation.brokerPlacementFingerprint !== binding.brokerPlacementFingerprint) {
            return failure('operation_not_current');
        }
        const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!source.success && source.reason === 'invalid_json') return failure('resource_unavailable');
        if (!source.success || JSON.stringify(source.data) !== operation.sourceBindingJson) {
            return failure('operation_not_current');
        }
    }
    // The presented Machine is the one the external placement owner already
    // resolved for this key's per-key operation and dispatched to — the
    // Machine that established it, or a fresh Pool selection. Pool tier
    // reordering, disabling and removal affect future opens only (L11/03 §6
    // step 7), so current membership is not an ongoing ACL here; an exact
    // placement still names its one Machine and eligibility is rechecked.
    const broker = await admitTeamCredentialBrokerMachineForResourceInTx(tx, {
        resource,
        brokerMachineId,
        selection: 'established',
    });
    if (!broker.ok) return failure(broker.error === 'update_required' ? 'broker_unavailable' : broker.error);
    return { ok: true as const, resource, externalApiKeyId: key.keyId };
}

/** Rechecks external-key metadata authority without reserving allowance,
 * recording usage, or resolving source credentials. A successful catalog
 * dispatch advances admitted-use time without creating a UsageEvent. */
export async function authorizeTeamCredentialExternalProviderModelCatalogInTx(
    tx: Tx,
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        request: unknown;
        observedAt: Date;
    }>,
): Promise<Readonly<{ ok: true }> | ReturnType<typeof failure>> {
    const parsed = TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema.safeParse(input.request);
    if (!parsed.success) return failure('invalid_request');
    const authorized = await authorizeCurrentExternalProviderKeyInTx(tx, {
        authenticatedBrokerAccountId: input.authenticatedBrokerAccountId,
        binding: parsed.data.binding,
        brokerMachineId: parsed.data.brokerMachineId,
        expectedResourceRevision: parsed.data.expectedResourceRevision,
        observedAt: input.observedAt,
    });
    if (!authorized.ok) return authorized;
    const updated = await tx.teamCredentialExternalApiKey.updateMany({
        where: {
            id: authorized.externalApiKeyId,
            resourceId: authorized.resource.id,
            membership: { status: 'active' },
            OR: [
                { lastUsedAt: null },
                { lastUsedAt: { lt: input.observedAt } },
            ],
        },
        data: { lastUsedAt: input.observedAt },
    });
    if (updated.count === 0) {
        const current = await tx.teamCredentialExternalApiKey.findFirst({
            where: {
                id: authorized.externalApiKeyId,
                resourceId: authorized.resource.id,
                membership: { status: 'active' },
            },
            select: { lastUsedAt: true },
        });
        if (!current?.lastUsedAt || current.lastUsedAt < input.observedAt) {
            return failure('operation_not_current');
        }
    }
    return { ok: true };
}

/** Rechecks the external key and all mutable authority inside the same
 * transaction that records the request-count fact. The bearer itself never
 * leaves the public edge. */
export async function admitTeamCredentialExternalProviderRequestInTx(
    tx: Tx,
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        request: unknown;
        observedAt: Date;
    }>,
): Promise<TeamCredentialExternalProviderAdmissionResponseV1> {
    const parsed = TeamCredentialExternalProviderAdmissionV1Schema.safeParse(input.request);
    if (!parsed.success) return failure('invalid_request');
    const { binding, brokerMachineId, expectedResourceRevision, application, requestFacts } = parsed.data;
    if (binding.kind !== 'external_api_key') return failure('invalid_request');
    if (binding.operationId === null) return failure('operation_not_current');
    const authorized = await authorizeCurrentExternalProviderKeyInTx(tx, {
        authenticatedBrokerAccountId: input.authenticatedBrokerAccountId,
        binding,
        brokerMachineId,
        expectedResourceRevision,
        observedAt: input.observedAt,
    });
    if (!authorized.ok) return authorized;
    const resource = authorized.resource;
    const expectedProtocol = requestFacts.routeKind === 'openai_responses'
        ? 'openai-responses'
        : requestFacts.routeKind === 'openai_chat_completions' ? 'openai-chat' : 'anthropic';
    if (application.protocol !== expectedProtocol) return failure('invalid_request');
    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!source.success) return failure('resource_unavailable');
    const current = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId, source: source.data,
    });
    if (current.status !== 'current') return failure('resource_unavailable');
    if (current.authenticationFailure) return failure(current.authenticationFailure);
    const requestId = `external:${binding.externalApiKeyId}:${binding.requestId}`;
    const usage = await admitTeamCredentialUsageInTx(tx, {
        storageAccountId: binding.assignedAccountId,
        sessionId: null,
        turnId: null,
        observedAt: input.observedAt,
        requestId,
        modelId: requestFacts.modelId,
        usageRoute: 'external_provider_terminal',
        authority: {
            kind: 'teamCredentialAdmission', requestingAccountId: binding.assignedAccountId,
            resourceId: resource.id, externalApiKeyId: binding.externalApiKeyId,
            sourceCredentialId: current.usageSourceMemberKey, workerMachineId: null, brokerMachineId,
            deliveryMode: 'external_api',
            executionRunId: null,
        },
    });
    if (!usage.ok) return failure(
        usage.reasonCode,
        usage.reasonCode === 'team_credential_usage_limit' ? usage.usageLimit : undefined,
    );
    if (!usage.created) return failure('duplicate_request');
    const usageEventId = usage.usageEventId;
    const terminalRequestId = requestFacts.generation ? requestId : null;
    return {
        ok: true, resourceId: resource.id, resourceRevision: resource.revision,
        brokerMachineId, source: source.data,
        operation: {
            kind: 'external_api_key', externalApiKeyId: binding.externalApiKeyId,
            operationId: binding.operationId,
            assignedAccountId: binding.assignedAccountId,
            assignedTeamMembershipId: binding.assignedTeamMembershipId,
        },
        usageEventId, terminalRequestId,
    };
}

/** Authenticates the reporting broker Machine, then delegates the immutable
 * terminal fact to the canonical UsageEvent writer. The broker carries the
 * Provider's own observed tokens for the routes whose protocol reports them and
 * `unavailable` otherwise. Explicit reported charges reuse the same request
 * identity; estimates are not broker usage facts. Revocation
 * after admission does not erase the already-observed terminal outcome. */
export async function recordTeamCredentialExternalProviderTerminalUsageInTx(
    tx: Tx,
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        request: unknown;
    }>,
): Promise<TeamCredentialExternalProviderTerminalUsageResponseV1> {
    const parsed = TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse(input.request);
    if (!parsed.success) return { ok: false, reasonCode: 'invalid_request' };
    const request = parsed.data;
    const brokerMachine = await tx.machine.findFirst({
        where: { id: request.brokerMachineId, accountId: input.authenticatedBrokerAccountId },
        select: { id: true },
    });
    if (!brokerMachine) return { ok: false, reasonCode: 'terminal_usage_mismatch' };
    const admission = await tx.usageEvent.findFirst({
        where: {
            id: request.admissionUsageEventId,
            externalKey: request.requestId,
            brokerMachineId: request.brokerMachineId,
            source: 'team_credential_admission',
            requestCount: 1,
            teamCredentialExternalApiKeyId: { not: null },
            teamCredentialResourceId: { not: null },
            teamCredentialActorAccountId: { not: null },
        },
        select: {
            accountId: true,
            teamCredentialResourceId: true,
            teamCredentialActorAccountId: true,
        },
    });
    if (!admission?.teamCredentialResourceId || !admission.teamCredentialActorAccountId) {
        return { ok: false, reasonCode: 'terminal_usage_mismatch' };
    }
    try {
        const result = await recordTeamCredentialExternalTerminalUsageEventInTx(tx, {
            accountId: admission.accountId,
            requestId: request.requestId,
            completedAt: new Date(request.completedAtMs),
            outcome: request.outcome,
            measurement: request.measurement,
            modelId: request.actualModelId,
            tokens: request.tokens,
            cost: request.reportedCostUsd === undefined ? null : {
                reportedUsd: request.reportedCostUsd,
                estimatedUsd: null,
                currency: 'USD',
                costSource: 'provider_reported',
                billingContext: 'api_usage',
            },
            authority: {
                kind: 'teamCredentialExternalTerminal',
                admissionUsageEventId: request.admissionUsageEventId,
                requestingAccountId: admission.teamCredentialActorAccountId,
                resourceId: admission.teamCredentialResourceId,
                brokerMachineId: request.brokerMachineId,
            },
        });
        return { ok: true, usageEventId: result.id, created: result.created };
    } catch {
        return { ok: false, reasonCode: 'terminal_usage_mismatch' };
    }
}
