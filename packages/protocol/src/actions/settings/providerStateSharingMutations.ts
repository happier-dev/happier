import type { AccountSettings } from '../../account/settings/accountSettings.js';
import { z } from '../../zodRuntimePolicy.js';

export const AgentProviderStateSharingChangeV1Schema = z.strictObject({
    agentId: z.string().check(z.trim(), z.minLength(1)),
    configMode: z.optional(z.enum(['linked', 'copied', 'isolated'])),
    stateMode: z.optional(z.enum(['shared', 'isolated'])),
}).check(z.refine(value => value.configMode !== undefined || value.stateMode !== undefined));

type SharingSettings = AccountSettings['connectedServicesProviderStateSharingSettingsV1'];
export type ProviderStateSharingSettingsMutationV1 = (current: SharingSettings) => SharingSettings | null;
export type ProviderStateSharingAgentV1 = Readonly<{
    agentId: string;
    capability?: Readonly<{ state?: Readonly<{
        supported: boolean;
        modes: readonly string[];
        sharedStatePrivacyRiskAcknowledgementRequired?: boolean;
    }> }> | null;
}>;

/** Both hosts project the same Agent capability facts before asking for named privacy consent. */
export function readProviderStateSharingRiskAgentIdsV1(agents: readonly ProviderStateSharingAgentV1[]): readonly string[] {
    return agents.filter(({ capability }) => capability?.state?.supported === true
        && capability.state.modes.includes('shared')
        && capability.state.sharedStatePrivacyRiskAcknowledgementRequired === true).map(({ agentId }) => agentId);
}

export type ProviderStateSharingMutationServicesV1 = Readonly<{
    /** Null means no authoritative Agent catalog is available, never an empty risk set. */
    readProviderStateSharingRiskAgentIds?: () => readonly string[] | null;
    /** Host-owned consent admission, including an Action waiver; never a caller-authored acknowledgement. */
    confirmProviderStateSharingRiskAgents?: (agentIds: readonly string[]) => Promise<boolean>;
}>;
export type ProviderStateSharingPreparationResultV1 =
    | Readonly<{ status: 'prepared'; mutate: ProviderStateSharingSettingsMutationV1 }>
    | Readonly<{ status: 'confirmation_required'; agentIds: readonly string[] }>
    | Readonly<{ status: 'catalog_unavailable' | 'cancelled' }>;

/** Prepare the incumbent default-sharing intent, then replay only its admitted risk set on CAS. */
export async function prepareDefaultProviderStateSharingChangeV1(
    settings: SharingSettings,
    shared: boolean,
    services: ProviderStateSharingMutationServicesV1,
): Promise<ProviderStateSharingPreparationResultV1> {
    const risks = shared ? services.readProviderStateSharingRiskAgentIds?.() : [];
    if (!risks) return { status: 'catalog_unavailable' };
    const unacknowledged = risks.filter(agentId => settings.acknowledgedRisksByAgentId[agentId]?.sharedStatePrivacy !== true);
    if (unacknowledged.length > 0) {
        if (!services.confirmProviderStateSharingRiskAgents) return { status: 'confirmation_required', agentIds: unacknowledged };
        if (!await services.confirmProviderStateSharingRiskAgents(unacknowledged)) return { status: 'cancelled' };
    }
    const admitted = new Set(risks);
    return { status: 'prepared', mutate: current => {
        const currentRisks = shared ? services.readProviderStateSharingRiskAgentIds?.() : [];
        if (!currentRisks || currentRisks.some(agentId => !admitted.has(agentId)
            && current.acknowledgedRisksByAgentId[agentId]?.sharedStatePrivacy !== true)) return null;
        const acknowledgedRisksByAgentId = { ...current.acknowledgedRisksByAgentId };
        for (const agentId of unacknowledged) acknowledgedRisksByAgentId[agentId] = {
            ...acknowledgedRisksByAgentId[agentId], sharedStatePrivacy: true,
        };
        return { ...current, defaults: { ...current.defaults, stateMode: shared ? 'shared' : 'isolated' }, acknowledgedRisksByAgentId };
    } };
}

/** The same consent policy, scoped to one Agent; no caller-authored acknowledgement is accepted. */
export async function prepareAgentProviderStateSharingChangeV1(
    settings: SharingSettings,
    change: z.infer<typeof AgentProviderStateSharingChangeV1Schema>,
    services: ProviderStateSharingMutationServicesV1,
): Promise<ProviderStateSharingPreparationResultV1> {
    const scopedServices: ProviderStateSharingMutationServicesV1 = { ...services,
        readProviderStateSharingRiskAgentIds: () => services.readProviderStateSharingRiskAgentIds?.()?.filter(id => id === change.agentId) ?? null,
    };
    const prepared = await prepareDefaultProviderStateSharingChangeV1(settings, change.stateMode === 'shared', scopedServices);
    if (prepared.status !== 'prepared') return prepared;
    return { status: 'prepared', mutate: current => {
        const consent = prepared.mutate(current);
        if (!consent) return null;
        return { ...current, byAgentId: { ...current.byAgentId, [change.agentId]: {
            ...current.byAgentId[change.agentId],
            ...(change.configMode !== undefined ? { configMode: change.configMode } : {}),
            ...(change.stateMode !== undefined ? { stateMode: change.stateMode } : {}),
        } }, acknowledgedRisksByAgentId: consent.acknowledgedRisksByAgentId };
    } };
}
