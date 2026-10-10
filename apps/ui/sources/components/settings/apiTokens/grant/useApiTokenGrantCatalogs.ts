import * as React from 'react';
import { getAgentStaticModels, type AgentId } from '@happier-dev/agents';
import type { ActionIdFamilyV1, ProviderBoundModelRef } from '@happier-dev/protocol';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { actionIdFamilyTitleKey } from '@/components/settings/actions/actionSettingsFamily';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { t } from '@/text';

import {
    buildApiTokenGrantActionGroups,
    buildApiTokenGrantModelOptions,
    resolveApiTokenGrantActionTitle,
    type ApiTokenGrantActionGroup,
    type ApiTokenGrantModelOption,
    type ApiTokenGrantNativeModel,
    type ApiTokenGrantProviderModelGroup,
} from './apiTokenGrantCatalog';
import { apiTokenGrantModelKey } from './apiTokenGrantDraft';

/** The Actions a token can be granted. Static for a build: the protocol spec catalog. */
export function useApiTokenGrantActionGroups(): readonly ApiTokenGrantActionGroup[] {
    return React.useMemo(() => buildApiTokenGrantActionGroups(), []);
}

export type { ApiTokenGrantModelOption } from './apiTokenGrantCatalog';

/** One Agent a grant can name models for: its catalog entry (null when this client has it off) and native models. */
export type ApiTokenGrantModelAgent = Readonly<{
    agentTargetKey: string;
    entry: ResolvedBackendCatalogEntry | null;
    title: string;
    nativeModels: readonly ApiTokenGrantNativeModel[];
}>;

export type ApiTokenGrantModelGroup = Readonly<{
    agentTargetKey: string;
    entry: ResolvedBackendCatalogEntry | null;
    title: string;
    models: readonly ApiTokenGrantModelOption[];
}>;

const NO_NATIVE_MODELS: readonly ApiTokenGrantNativeModel[] = Object.freeze([]);
const NO_PROVIDER_GROUPS: readonly ApiTokenGrantProviderModelGroup[] = Object.freeze([]);

/**
 * Every enabled Agent, with its native catalog models, plus an entry for each Agent a granted ref
 * names that this client does not have enabled (so that ref stays visible and removable).
 */
export function useApiTokenGrantModelAgents(granted: readonly ProviderBoundModelRef[] | null): readonly ApiTokenGrantModelAgent[] {
    const { snapshot: acpCatalog } = useAcpCatalog();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const enabledAgents = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
        acpCatalogSnapshot: acpCatalog?.catalog,
        backendEnabledByTargetKey,
    }).map((entry): ApiTokenGrantModelAgent => {
        const agentId = entry.agentCatalogEntry.catalogAgentId;
        return {
            agentTargetKey: entry.backendTargetKey,
            entry,
            title: entry.agentCatalogEntry.title,
            nativeModels: agentId ? readStaticModels(agentId) : NO_NATIVE_MODELS,
        };
    }), [acpCatalog, backendEnabledByTargetKey]);
    return React.useMemo(() => {
        const known = new Set(enabledAgents.map((agent) => agent.agentTargetKey));
        const orphans: ApiTokenGrantModelAgent[] = [];
        for (const ref of granted ?? []) {
            if (known.has(ref.agentTargetKey)) continue;
            known.add(ref.agentTargetKey);
            orphans.push({ agentTargetKey: ref.agentTargetKey, entry: null, title: ref.agentTargetKey, nativeModels: NO_NATIVE_MODELS });
        }
        return orphans.length === 0 ? enabledAgents : [...enabledAgents, ...orphans];
    }, [enabledAgents, granted]);
}

/**
 * Names and identities for granted models, without asking any computer: native catalog names, and
 * each granted ref under its Agent. Display only (token details, summaries); choosing models reads
 * the provider-model projection (`useApiTokenGrantProviderModelGroups`).
 */
export function useApiTokenGrantModelGroups(granted: readonly ProviderBoundModelRef[] | null): readonly ApiTokenGrantModelGroup[] {
    const agents = useApiTokenGrantModelAgents(granted);
    return React.useMemo(() => agents.flatMap((agent): ApiTokenGrantModelGroup[] => {
        const models = buildApiTokenGrantModelOptions({
            agentTargetKey: agent.agentTargetKey,
            nativeModels: agent.nativeModels,
            providerGroups: NO_PROVIDER_GROUPS,
            granted,
        });
        return models.length > 0 ? [{ agentTargetKey: agent.agentTargetKey, entry: agent.entry, title: agent.title, models }] : [];
    }), [agents, granted]);
}

/**
 * The computer whose provider-model projection lists the choosable models: the grant's creation
 * computer when it has one (chats this key creates run there), else the Provider settings target.
 */
export function useApiTokenGrantModelMachine(createMachineId: string | null): Readonly<{ machineId: string | null; serverId: string | null }> {
    const target = useProviderSettingsTarget();
    if (createMachineId) {
        return { machineId: createMachineId, serverId: target.machineId === createMachineId ? target.serverId : null };
    }
    return { machineId: target.machineId, serverId: target.serverId };
}

/** One Agent's provider-connected models, from the canonical provider-model projection. */
export function useApiTokenGrantProviderModelGroups(input: Readonly<{
    agentTargetKey: string;
    machineId: string | null;
    serverId: string | null;
}>): readonly ApiTokenGrantProviderModelGroup[] {
    const enabled = useFeatureEnabled('providers');
    const projection = useProviderModelProjection({
        enabled,
        machineId: input.machineId,
        serverId: input.serverId,
        agentTargetKey: input.agentTargetKey,
        mode: 'picker',
    });
    return projection.data?.groups ?? NO_PROVIDER_GROUPS;
}

function readStaticModels(agentId: AgentId): readonly ApiTokenGrantNativeModel[] {
    try {
        return getAgentStaticModels(agentId).map((model) => ({ id: model.id, name: model.name || model.id, description: model.description ?? null }));
    } catch {
        return NO_NATIVE_MODELS;
    }
}

export type ApiTokenGrantNames = Readonly<{
    familyName: (family: ActionIdFamilyV1) => string | null;
    actionName: (actionId: string) => string | null;
    modelName: (ref: ProviderBoundModelRef) => string | null;
}>;

/** Names for access summaries: Action families and titles, and model names from the catalog. */
export function useApiTokenGrantNames(): ApiTokenGrantNames {
    const actionGroups = useApiTokenGrantActionGroups();
    const modelGroups = useApiTokenGrantModelGroups(null);
    return React.useMemo(() => {
        const modelNames = new Map(modelGroups.flatMap((group) => group.models.map((model) => [model.key, model.name] as const)));
        return {
            familyName: (family) => t(actionIdFamilyTitleKey(family)),
            actionName: (actionId) => resolveApiTokenGrantActionTitle(actionId, actionGroups),
            modelName: (ref) => modelNames.get(apiTokenGrantModelKey(ref)) ?? null,
        };
    }, [actionGroups, modelGroups]);
}
