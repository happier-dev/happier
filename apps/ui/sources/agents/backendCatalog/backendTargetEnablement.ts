import * as agents from '@happier-dev/agents';
import { readAccountSettingValueForBackendTarget } from '@happier-dev/protocol/account/settings/accountSettings';
import type { BackendTargetRefV2, BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';

function readSettingsBackendId(providerProjection: MergedProviderProjectionEntry | null | undefined): string | null {
    const settingsBackendId = typeof providerProjection?.settingsBackendId === 'string'
        ? providerProjection.settingsBackendId.trim()
        : '';
    return settingsBackendId || null;
}

function readProviderContractCompatibilityBackendIds(providerId: string): readonly string[] {
    if (!('getAgentDefinitionContract' in agents)) {
        return [];
    }

    const maybeGetProviderDefinitionContract = (agents as unknown as {
        getAgentDefinitionContract?: (agentId: string) => { enablementCompatibilityBackendIds?: readonly string[] } | null;
    }).getAgentDefinitionContract;
    if (typeof maybeGetProviderDefinitionContract !== 'function') {
        return [];
    }

    try {
        const contract = maybeGetProviderDefinitionContract(providerId);
        return (contract?.enablementCompatibilityBackendIds ?? [])
            .map((backendId) => (typeof backendId === 'string' ? backendId.trim() : ''))
            .filter((backendId) => backendId.length > 0);
    } catch {
        return [];
    }
}

export function getAgentBackendCompatibilityTargetKeys(params: Readonly<{
    agentId: string;
    canonicalTargetKey?: string | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
}>): readonly string[] {
    return getAgentBackendCompatibilityTargets(params).map(resolveBackendTargetKeyV2);
}

export function getAgentBackendCompatibilityTargets(params: Readonly<{
    agentId: string;
    canonicalTargetKey?: string | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
}>): readonly BackendTargetRefV2[] {
    const providerId = params.agentId.trim();
    if (!providerId) return [];

    const compatibilityBackendIds = new Set<string>();
    const providerProjection = params.mergedProviderProjectionById?.[providerId] ?? null;
    const settingsBackendId = readSettingsBackendId(providerProjection);
    if (settingsBackendId) {
        compatibilityBackendIds.add(settingsBackendId);
    }
    for (const backendId of readProviderContractCompatibilityBackendIds(providerId)) {
        compatibilityBackendIds.add(backendId);
    }

    for (const [backendId, backendProjection] of Object.entries(params.mergedBackendProjectionById ?? {})) {
        if (backendProjection.agentId === providerId) {
            compatibilityBackendIds.add(backendId);
        }
    }

    const normalizedProviderId = providerId.trim();
    const canonicalTargetKey = params.canonicalTargetKey ?? resolveBackendTargetKeyV2({
        kind: 'backend',
        backendId: normalizedProviderId,
    });

    compatibilityBackendIds.delete(normalizedProviderId);
    const compatibilityTargetsByKey = new Map<string, BackendTargetRefV2>();
    for (const backendId of compatibilityBackendIds) {
        const bareTarget: BackendTargetRefV2 = { kind: 'backend', backendId };
        const bareTargetKey = resolveBackendTargetKeyV2(bareTarget);
        if (bareTargetKey !== canonicalTargetKey) {
            compatibilityTargetsByKey.set(bareTargetKey, bareTarget);
        }

    }

    return [...compatibilityTargetsByKey.values()];
}

export function readBackendTargetEnabled(params: Readonly<{
    backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined;
    canonicalTargetKey: string;
    compatibilityTargetKeys?: readonly string[];
}>): boolean {
    const settings = { backendEnabledByTargetKey: params.backendEnabledByTargetKey };
    // This boundary accepts string keys; Protocol validates and normalizes their vocabulary.
    const readEnabled = (targetKey: string) => readAccountSettingValueForBackendTarget(
        settings, 'backendEnabledByTargetKey', targetKey as BackendTargetRefV2Input,
    );
    const canonicalEnabledState = readEnabled(params.canonicalTargetKey);
    if (canonicalEnabledState !== undefined) {
        return canonicalEnabledState !== false;
    }

    for (const compatibilityTargetKey of params.compatibilityTargetKeys ?? []) {
        if (readEnabled(compatibilityTargetKey) === false) {
            return false;
        }
    }

    return true;
}
