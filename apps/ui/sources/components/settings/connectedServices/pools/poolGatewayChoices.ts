import type { ProviderConnectionV1, ProviderConnectionPurposeBindingDefaultsV1 } from '@happier-dev/protocol/providers/connections/v1';
import { buildProviderGatewaySlotMutation } from '@/providers/connection/gatewayConfiguration';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { connectedAccountPurposeTargetChoiceId } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { isProviderGatewayOnInCatalog, readProviderGatewayPurposeDeclarations } from '../../providers/collection/providerCollectionModel';
import { buildConnectedServicesGatewayRoute } from '../collection/connectedServicesCollectionRoutes';

type PoolTarget = Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>;
export type PoolGatewayChoice = Readonly<{
    connectionId: ProviderConnectionV1['id'];
    title: string;
    detailRoute: string;
    revision: number;
    purpose: string;
    service: PoolTarget['service'];
    /** This pool holds the gateway's slot. */
    enabled: boolean;
    /** The gateway itself is on (the rail's and its page's one fact); a held slot serves nothing while it is off. */
    gatewayOn: boolean;
    /** The exact account or pool the approved update will replace. */
    replacementTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    purposeBindingDefaults: ProviderConnectionPurposeBindingDefaultsV1;
}>;

/** The contribution supplies vendor slots; a pool supplies its qualified service, never a protocol. */
export function buildPoolGatewayChoices(input: Readonly<{
    connections: readonly ProviderConnectionV1[];
    target: PoolTarget;
    accountGrants: readonly Readonly<{ connectionId: string }>[];
    machineGrants: readonly Readonly<{ connectionId: string }>[];
}>): readonly PoolGatewayChoice[] {
    const choices: PoolGatewayChoice[] = [];
    const serviceKey = buildQualifiedPluginContributionKey(input.target.service);
    const targetKey = connectedAccountPurposeTargetChoiceId(input.target);
    for (const saved of input.connections) {
        const declarations = readProviderGatewayPurposeDeclarations(saved, { kind: 'account' });
        if (!declarations) continue;
        const gatewayOn = isProviderGatewayOnInCatalog({ connectionId: saved.id, accountGrants: input.accountGrants, machineGrants: input.machineGrants });
        for (const declaration of declarations) {
            if (buildQualifiedPluginContributionKey(declaration.service) !== serviceKey) continue;
            const purposeBindingDefaults = saved.purposeBindingDefaults ?? {};
            const current = purposeBindingDefaults[declaration.purpose] ?? null;
            const enabled = connectedAccountPurposeTargetChoiceId(current) === targetKey;
            choices.push({ connectionId: saved.id, title: saved.displayName, detailRoute: buildConnectedServicesGatewayRoute({ connectionId: saved.id }),
                revision: saved.revision, purpose: declaration.purpose, service: declaration.service, enabled, gatewayOn,
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
    machineId?: string | null;
}>): ReturnType<typeof buildProviderGatewaySlotMutation> | null {
    const { choice, target } = input;
    if (buildQualifiedPluginContributionKey(choice.service) !== buildQualifiedPluginContributionKey(target.service)) return null;
    const current = choice.purposeBindingDefaults[choice.purpose] ?? null;
    const ownsSlot = connectedAccountPurposeTargetChoiceId(current) === connectedAccountPurposeTargetChoiceId(target);
    if (input.enabled === ownsSlot) return null;
    return buildProviderGatewaySlotMutation({ connectionId: choice.connectionId, expectedRevision: choice.revision,
        purposeBindingDefaults: choice.purposeBindingDefaults, machineId: input.machineId, purpose: choice.purpose,
        target: input.enabled ? target : null });
}
