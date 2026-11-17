import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceBindingsV2, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol';

import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

import type {
    ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import type {
    ConnectedAccountRequestAuthCapabilityDescriptor,
} from './capabilityFile';
import type {
    ConnectedAccountRequestAuthSubjectRegistry,
} from './ConnectedAccountRequestAuthSubjectRegistry';
import {
    projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot,
    type QualifiedPurposeTeamDirectMaterialOrigin,
} from './firstPartyConnectedAccountRequestAuthAdapter';
import type {
    ConnectedAccountPurposeAuthorizationScope,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';

import { assertLaunchPurposeDeliverySupported, resolveLaunchPurposeDeclarations, mergeLaunchPurposeDeclarationSnapshots } from './agentPurposeDeclarations';
import type { AgentSpawnPurposeAuthorizationScope, AgentSpawnPurposeContributions, AgentSpawnPurposeCatalogEntry, AgentSpawnQualifiedFileEnvironmentUse, AgentSpawnQualifiedEnvironmentUse } from './agentPurposeDeclarations';
export { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from './agentPurposeDeclarations';
export type { AgentSpawnPurposeContributions, AgentSpawnQualifiedPurposeDeclarationSnapshot, AgentSpawnQualifiedFileEnvironmentUse, AgentSpawnQualifiedEnvironmentUse } from './agentPurposeDeclarations';

export type AgentSpawnQualifiedPurposeBindingSnapshot = Readonly<{
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    directMaterialOrigins?: readonly QualifiedPurposeTeamDirectMaterialOrigin[];
    authorizedPurposes?: readonly AgentSpawnPurposeAuthorizationScope[];
    fileMaterializationPurposes?: readonly ConnectedAccountPurposeAuthorizationScope[];
    requestAuthUses?: readonly QualifiedConnectedAccountRequestAuthUseV1[];
    fileEnvironmentUses?: readonly AgentSpawnQualifiedFileEnvironmentUse[];
    environmentUses?: readonly AgentSpawnQualifiedEnvironmentUse[];
    environmentUnsetUses?: readonly AgentSpawnQualifiedEnvironmentUse[];
}>;

/**
 * Live compatibility ingress for released Agent/session `connectedServices`. The cold manifest is
 * the sole purpose declaration owner; the released service-keyed selection is translated in
 * memory and is never persisted or written back from the qualified-purpose path.
 */
export function resolveQualifiedPurposeBindingsForAgentSpawn(input: Readonly<{
    agentId: string;
    bindings: ConnectedServiceBindingsV2;
    contributions: AgentSpawnPurposeContributions;
}>): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    return resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input)?.bindings
        ?? Object.freeze([]);
}

export function resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn(
    input: Readonly<{
        agentId: string;
        bindings: ConnectedServiceBindingsV2;
        contributions: AgentSpawnPurposeContributions;
    }>,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    const snapshot =
        resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input);
    return resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(snapshot);
}

export function resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
    snapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
    if (!snapshot?.requestAuthUses?.length) return Object.freeze([]);
    const requestAuthPurposeKeys = new Set(
        snapshot.requestAuthUses.map((use) =>
            qualifiedPurposeKey(use.purpose),
        ),
    );
    return Object.freeze(snapshot.bindings.filter((binding) =>
        requestAuthPurposeKeys.has(qualifiedPurposeKey(binding.purpose))));
}

export function resolveQualifiedPurposeBindingSnapshotForAgentSpawn(input: Readonly<{
    agentId: string;
    bindings: ConnectedServiceBindingsV2;
    contributions: AgentSpawnPurposeContributions;
    catalogEntry?: AgentSpawnPurposeCatalogEntry | null;
    teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
}>): AgentSpawnQualifiedPurposeBindingSnapshot | null {
    const declarations = resolveLaunchPurposeDeclarations(input);
    if (!declarations.length) return null;
    assertLaunchPurposeDeliverySupported({ declarations, readDeliveryMode: scope => {
        for (const service of scope.serviceRefs) {
            const selection = input.bindings.bindingsByServiceId[buildQualifiedPluginContributionKey(service)];
            if (selection?.source === 'team_resource') return selection.deliveryMode;
        }
        return null;
    } });
    const snapshots = declarations.map(declaration => {
        return projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot({ consumer: declaration.consumer,
            declarations: declaration.declarations, bindings: input.bindings });
    });
    const snapshot = { purposes: snapshots.flatMap(value => value.purposes), bindings: snapshots.flatMap(value => value.bindings),
        ...(snapshots.some(value => value.directMaterialOrigins) ? { directMaterialOrigins: snapshots.flatMap(value => value.directMaterialOrigins ?? []) } : {}) };
    const launch = mergeLaunchPurposeDeclarationSnapshots(declarations.map(declaration => declaration.snapshot));
    return {
        ...snapshot,
        ...(snapshot.directMaterialOrigins ? { directMaterialOrigins: snapshot.directMaterialOrigins.map(origin => {
            const binding = input.teamCredentialBindings?.find(binding => binding.slot.kind === 'connected_service_purpose'
                && qualifiedPurposeKey(binding.slot.purpose) === qualifiedPurposeKey(origin.purpose)
                && binding.resourceId === origin.resourceId);
            return binding?.resourceId && binding.teamId ? { ...origin, teamId: binding.teamId } : origin;
        }) } : {}),
        authorizedPurposes: launch.authorizedPurposes,
        fileMaterializationPurposes: launch.fileMaterializationPurposes,
        ...(launch.requestAuthUses
            ? { requestAuthUses: launch.requestAuthUses }
            : {}),
        ...(launch.fileEnvironmentUses
            ? { fileEnvironmentUses: launch.fileEnvironmentUses }
            : {}),
        ...(launch.environmentUses
            ? { environmentUses: launch.environmentUses }
            : {}),
        ...(launch.environmentUnsetUses
            ? { environmentUnsetUses: launch.environmentUnsetUses }
            : {}),
    };
}

export async function activateConnectedAccountRequestAuthForSpawn(input: Readonly<{
    materializationId: string;
    materializedRootDir: string;
    httpPort: number;
    subject: ConnectedAccountRequestAuthSubject;
    registry: Pick<
        ConnectedAccountRequestAuthSubjectRegistry,
        'activate' | 'retire'
    >;
    launchResourceScope: Pick<ProviderLaunchResourceScope, 'register'>;
}>): Promise<ConnectedAccountRequestAuthCapabilityDescriptor> {
    const descriptor = await input.registry.activate({
        subject: input.subject,
        materializedRootDir: input.materializedRootDir,
        materializationId: input.materializationId,
        httpPort: input.httpPort,
    });
    let retired = false;
    const retire = async () => {
        if (retired) return;
        retired = true;
        await input.registry.retire(descriptor);
    };
    try {
        input.launchResourceScope.register({
            onFailure: retire,
            onExit: retire,
        });
    } catch (error) {
        await retire();
        throw error;
    }
    return descriptor;
}
