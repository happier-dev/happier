import { TeamCredentialRequestPolicyModelSupportV1Schema, TeamCredentialProviderModelCatalogEntryV1Schema, type TeamCredentialRequestPolicyModelSupportV1, type TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { admitTeamCredentialSourceModelRowsV1, DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema, type TeamCredentialSourceModelProjectionFailureV1, type DaemonProviderTeamCredentialRequestPolicySupportV1 } from '@happier-dev/protocol/rpc/providers';
import {
    selectMachinePoolCandidate,
    type MachinePoolSelectableMemberV1,
} from "@happier-dev/protocol/machines/pools";

function providerModelCandidateKey(model: TeamCredentialProviderModelCatalogEntryV1): string {
    return JSON.stringify([
        model.selection.modelId,
        model.application.agentTargetKey,
        model.application.implementationIdentity.pluginId,
        model.application.implementationIdentity.localId,
        model.application.endpointTemplateId,
        model.application.protocol,
        model.selection.deliveryMode,
        model.availability,
    ]);
}

function requestPolicySupportCandidateKey(model: TeamCredentialRequestPolicyModelSupportV1): string {
    return JSON.stringify([
        model.descriptor.id,
        model.application.agentTargetKey,
        model.application.implementationIdentity.pluginId,
        model.application.implementationIdentity.localId,
        model.application.endpointTemplateId,
        model.application.protocol,
        model.sourceRevision,
        model.allowedProtocolKinds,
        model.reasoningEffort,
    ]);
}

export type TeamCredentialProviderModelProjection =
    | Readonly<{ status: 'success'; models: readonly TeamCredentialProviderModelCatalogEntryV1[] }>
    | (TeamCredentialSourceModelProjectionFailureV1 & Readonly<{ models: readonly TeamCredentialProviderModelCatalogEntryV1[] }>);

/**
 * Projects only daemon-owned, value-free facts. Unsupported or absent facts
 * remain null; the Home never derives capability support from a source kind,
 * model name, or executable protocol.
 */
function projectRequestPolicySupportModel(
    support: DaemonProviderTeamCredentialRequestPolicySupportV1,
): TeamCredentialRequestPolicyModelSupportV1 | null {
    if (support.model.canonicalId !== support.descriptor.id) return null;
    const candidate = TeamCredentialRequestPolicyModelSupportV1Schema.safeParse({
        descriptor: support.descriptor,
        application: support.application,
        sourceRevision: support.sourceRevision,
        allowedProtocolKinds: [support.protocolKind],
        reasoningEffort: support.reasoningEffort.supported
            ? {
                allowedValues: support.reasoningEffort.allowedValues,
                defaultValue: support.reasoningEffort.defaultValue,
            }
            : null,
    });
    return candidate.success ? candidate.data : null;
}

/**
 * Projects the daemon's source-only discovery result into the public value-free
 * editor contract. Application identity and source currentness are daemon-owned;
 * the Home only validates and narrows the projection.
 */
export function projectTeamCredentialRequestPolicySupportModels(
    response: unknown,
): readonly TeamCredentialRequestPolicyModelSupportV1[] {
    const discovered = DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema.safeParse(response);
    if (!discovered.success || discovered.data.status !== "success") return [];
    return discovered.data.models.flatMap(support => {
        const model = projectRequestPolicySupportModel(support);
        return model ? [model] : [];
    });
}

type PoolBackedModelsInput<T> = Readonly<{
    members: readonly Readonly<MachinePoolSelectableMemberV1>[];
    availableMachineIds: ReadonlySet<string>;
    candidates: readonly Readonly<{
        machineId: string;
        model: T;
    }>[];
    requestKey: string;
}>;

function selectPoolBackedModels<T>(input: PoolBackedModelsInput<T>, candidateKey: (model: T) => string): readonly T[] {
    const byModel = new Map<string, typeof input.candidates[number][]>();
    for (const candidate of input.candidates) {
        if (!input.availableMachineIds.has(candidate.machineId)) continue;
        const key = candidateKey(candidate.model);
        const entries = byModel.get(key) ?? [];
        entries.push(candidate);
        byModel.set(key, entries);
    }
    return [...byModel.entries()].flatMap(([key, candidates]) => {
        const selected = selectMachinePoolCandidate({
            purpose: "session",
            members: input.members,
            availableMachineIds: new Set(candidates.map(candidate => candidate.machineId)),
            requestKey: `${input.requestKey}\u0000${key}`,
        });
        if (!selected) return [];
        const model = candidates.find(candidate => candidate.machineId === selected.machineId)?.model;
        return model ? [model] : [];
    });
}

/** Uses the same canonical per-row Pool choice as the provider-model catalog. */
export function selectPoolBackedTeamCredentialRequestPolicySupportModels(
    input: PoolBackedModelsInput<TeamCredentialRequestPolicyModelSupportV1>,
): readonly TeamCredentialRequestPolicyModelSupportV1[] {
    return selectPoolBackedModels(input, requestPolicySupportCandidateKey);
}

/**
 * Chooses the canonical Pool member independently for each recipient-safe
 * model row. Machine identity remains Home-local and never crosses the catalog
 * projection; a later broker open revalidates and pins its own exact target.
 */
export function selectPoolBackedTeamCredentialProviderModels(
    input: PoolBackedModelsInput<TeamCredentialProviderModelCatalogEntryV1>,
): readonly TeamCredentialProviderModelCatalogEntryV1[] {
    return selectPoolBackedModels(input, providerModelCandidateKey);
}

/** One projection policy shared by catalog display and Runner selection review. */
export function projectTeamCredentialProviderModels(input: Readonly<{
    response: unknown;
    resourceId: string;
    teamId: string;
    resourceRevision: number;
    agentTargetKey: string;
    application: ProviderBrokerApplicationBindingV1;
    allowedModelIds: readonly string[] | null;
    source: TeamCredentialSourceBindingV1;
    deliveryMode: 'brokered' | 'direct';
    directMaterialReferences?: readonly Readonly<{ sourceMemberKey: string; sourceVersion: string }>[];
}>): TeamCredentialProviderModelProjection {
    const admitted = admitTeamCredentialSourceModelRowsV1(input.response);
    if (admitted.status !== 'success') return { ...admitted, models: [] };
    const allowed = input.allowedModelIds === null ? null : new Set(input.allowedModelIds);
    let sourceRowCount = 0;
    let applicationRowCount = 0;
    const models = admitted.rows.flatMap(({ group, row, sourceRevision }) => {
            if (input.source.kind === 'provider_connection' && (
                group.connectionId !== input.source.connectionId
                || group.sourceAuthority?.connectionSecurityFingerprint !== input.source.connectionSecurityFingerprint
            )) return [];
            sourceRowCount += 1;
            if (row.application.agentTargetKey !== input.application.agentTargetKey
                || row.application.implementationIdentity.pluginId !== input.application.implementationIdentity.pluginId
                || row.application.implementationIdentity.localId !== input.application.implementationIdentity.localId
                || row.application.endpointTemplateId !== input.application.endpointTemplateId
                || row.application.protocol !== input.application.protocol) return [];
            applicationRowCount += 1;
            if (row.application.agentTargetKey !== input.agentTargetKey
                || (allowed !== null && !allowed.has(row.descriptor.id))) return [];
            const candidate = TeamCredentialProviderModelCatalogEntryV1Schema.safeParse({
                selection: {
                    kind: "team_credential_provider_model",
                    resourceId: input.resourceId,
                    teamId: input.teamId,
                    expectedResourceRevision: input.resourceRevision,
                    agentTargetKey: input.agentTargetKey,
                    modelId: row.descriptor.id,
                    deliveryMode: input.deliveryMode,
                },
                descriptor: row.descriptor,
                sources: row.sources,
                confidence: row.confidence,
                application: row.application,
                ...(row.sourceFacts ? { sourceFacts: row.sourceFacts } : {}),
                compatibility: { ...row.compatibility, confirmed: false },
                sourceRevision,
                direct: input.deliveryMode === 'direct'
                    && input.directMaterialReferences?.length === 1
                    && row.directMaterialization
                    ? input.directMaterialReferences[0]
                    : null,
                availability: input.deliveryMode === 'direct'
                    && !(input.directMaterialReferences?.length === 1 && row.directMaterialization)
                    ? "source_owner_required"
                    : "available",
            });
            return candidate.success ? [candidate.data] : [];
    });
    if (admitted.rows.length > 0 && sourceRowCount === 0) {
        return { status: 'unavailable', reason: 'response_invalid', models: [] };
    }
    if (sourceRowCount > 0 && applicationRowCount === 0) {
        return { status: 'unavailable', reason: 'incompatible', models: [] };
    }
    return { status: 'success', models };
}
