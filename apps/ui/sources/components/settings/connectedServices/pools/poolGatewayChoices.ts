import type { ProviderConnectionV1, ProviderConnectionPurposeBindingDefaultsV1 } from '@happier-dev/protocol/providers/connections/v1';
import type { DaemonProviderConnectionMutationRequestV1, DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import { buildProviderGatewaySlotMutation } from '@/providers/connection/gatewayConfiguration';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { connectedAccountPurposeTargetChoiceId } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { providerConnectionDetailRoute, readProviderGatewayPurposeDeclarations } from '../../providers/collection/providerCollectionModel';

type PoolTarget = Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>;
export type PoolGatewayChoice = Readonly<{
    connectionId: ProviderConnectionV1['id'];
    title: string;
    detailRoute: string;
    revision: number;
    purpose: string;
    service: PoolTarget['service'];
    enabled: boolean;
    /** The exact account or pool the approved update will replace. */
    replacementTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    purposeBindingDefaults: ProviderConnectionPurposeBindingDefaultsV1;
}>;

/** The contribution supplies vendor slots; a pool supplies its qualified service, never a protocol. */
export function buildPoolGatewayChoices(input: Readonly<{
    connections: readonly ProviderConnectionV1[];
    views: readonly DaemonProviderConnectionViewV1[];
    target: PoolTarget;
}>): readonly PoolGatewayChoice[] {
    const choices: PoolGatewayChoice[] = [];
    const serviceKey = buildQualifiedPluginContributionKey(input.target.service);
    const targetKey = connectedAccountPurposeTargetChoiceId(input.target);
    const connectionsById = new Map(input.connections.map(connection => [connection.id, connection]));
    for (const view of input.views) {
        const saved = connectionsById.get(view.connectionId);
        const declarations = saved ? readProviderGatewayPurposeDeclarations(saved, view) : null;
        if (!saved || !declarations) continue;
        for (const declaration of declarations) {
            if (buildQualifiedPluginContributionKey(declaration.service) !== serviceKey) continue;
            const purposeBindingDefaults = saved.purposeBindingDefaults ?? {};
            const current = purposeBindingDefaults[declaration.purpose] ?? null;
            const enabled = connectedAccountPurposeTargetChoiceId(current) === targetKey;
            choices.push({ connectionId: saved.id, title: saved.displayName, detailRoute: providerConnectionDetailRoute(saved.id),
                revision: saved.revision, purpose: declaration.purpose, service: declaration.service, enabled,
                replacementTarget: enabled ? null : current, purposeBindingDefaults });
        }
    }
    return choices;
}

/** Capture revision and one vendor-slot delta for the incumbent update Action/CAS writer. */
export function buildPoolGatewayMutation(input: Readonly<{
    choice: PoolGatewayChoice;
    target: PoolTarget;
    enabled: boolean;
    machineId: string;
}>): Extract<DaemonProviderConnectionMutationRequestV1, { action: 'update' }> | null {
    const { choice, target } = input;
    if (buildQualifiedPluginContributionKey(choice.service) !== buildQualifiedPluginContributionKey(target.service)) return null;
    const current = choice.purposeBindingDefaults[choice.purpose] ?? null;
    const ownsSlot = connectedAccountPurposeTargetChoiceId(current) === connectedAccountPurposeTargetChoiceId(target);
    if (input.enabled === ownsSlot) return null;
    return buildProviderGatewaySlotMutation({ connectionId: choice.connectionId, expectedRevision: choice.revision,
        purposeBindingDefaults: choice.purposeBindingDefaults, machineId: input.machineId, purpose: choice.purpose,
        target: input.enabled ? target : null });
}
