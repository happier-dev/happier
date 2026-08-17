import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function buildExecutionRunsGuidanceSummaryProperties(value: unknown): Record<string, number> {
    const entries = Array.isArray(value) ? value : [];

    let enabledCount = 0;
    let withSuggestedBackendCount = 0;
    let withSuggestedModelCount = 0;
    let delegateCount = 0;
    let reviewCount = 0;
    let planCount = 0;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;

        if (record.enabled === true) enabledCount += 1;
        if (record.suggestedBackendTarget && typeof record.suggestedBackendTarget === 'object' && !Array.isArray(record.suggestedBackendTarget)) {
            withSuggestedBackendCount += 1;
        }
        if (typeof record.suggestedModelId === 'string' && record.suggestedModelId.length > 0) {
            withSuggestedModelCount += 1;
        }
        if (record.suggestedIntent === 'delegate') delegateCount += 1;
        if (record.suggestedIntent === 'review') reviewCount += 1;
        if (record.suggestedIntent === 'plan') planCount += 1;
    }

    return {
        totalCount: entries.length,
        enabledCount,
        withSuggestedBackendCount,
        withSuggestedModelCount,
        delegateCount,
        reviewCount,
        planCount,
    };
}

function buildSessionTmuxOverrideSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];

    let useTmuxCount = 0;
    let isolatedCount = 0;
    let customTmpDirCount = 0;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;

        if (record.useTmux === true) useTmuxCount += 1;
        if (record.isolated === true) isolatedCount += 1;
        if (typeof record.tmpDir === 'string' && record.tmpDir.length > 0) customTmpDirCount += 1;
    }

    return {
        overrideCount: entries.length,
        useTmuxCount,
        isolatedCount,
        customTmpDirCount,
    };
}

function buildInstallablesPolicySummaryProperties(value: unknown): Record<string, number> {
    const machineEntries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];

    let totalInstallableOverrideCount = 0;
    let autoInstallOverrideCount = 0;
    let autoUpdateOffCount = 0;
    let autoUpdateNotifyCount = 0;
    let autoUpdateAutoCount = 0;

    for (const machineEntry of machineEntries) {
        if (!machineEntry || typeof machineEntry !== 'object' || Array.isArray(machineEntry)) continue;
        const installableEntries = Object.values(machineEntry as Record<string, unknown>);

        totalInstallableOverrideCount += installableEntries.length;

        for (const installableEntry of installableEntries) {
            if (!installableEntry || typeof installableEntry !== 'object' || Array.isArray(installableEntry)) continue;
            const record = installableEntry as Record<string, unknown>;

            if (record.autoInstallWhenNeeded === true) autoInstallOverrideCount += 1;
            if (record.autoUpdateMode === 'off') autoUpdateOffCount += 1;
            if (record.autoUpdateMode === 'notify') autoUpdateNotifyCount += 1;
            if (record.autoUpdateMode === 'auto') autoUpdateAutoCount += 1;
        }
    }

    return {
        machineCount: machineEntries.length,
        totalInstallableOverrideCount,
        autoInstallOverrideCount,
        autoUpdateOffCount,
        autoUpdateNotifyCount,
        autoUpdateAutoCount,
    };
}

function buildAcpCatalogSummaryProperties(value: unknown): Record<string, number> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as { backends?: unknown }
        : {};

    return {
        backendCount: Array.isArray(record.backends) ? record.backends.length : 0,
    };
}

function buildPeerMediationPreferencesSummaryProperties(value: unknown): Record<string, number> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as { byMachineId?: unknown; flows?: unknown }
        : {};
    const accountFlows = record.flows && typeof record.flows === 'object' && !Array.isArray(record.flows)
        ? Object.values(record.flows as Record<string, unknown>)
        : [];
    const machineEntries = record.byMachineId && typeof record.byMachineId === 'object' && !Array.isArray(record.byMachineId)
        ? Object.values(record.byMachineId as Record<string, unknown>)
        : [];

    let accountDirectOverrideCount = 0;
    let machineDirectOverrideCount = 0;
    let directEnabledCount = 0;
    let directDisabledCount = 0;

    const countFlowPreference = (entry: unknown, scope: 'account' | 'machine') => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const direct = (entry as Record<string, unknown>).direct;
        if (direct !== 'enabled' && direct !== 'disabled') return;
        if (scope === 'account') {
            accountDirectOverrideCount += 1;
        } else {
            machineDirectOverrideCount += 1;
        }
        if (direct === 'enabled') directEnabledCount += 1;
        if (direct === 'disabled') directDisabledCount += 1;
    };

    for (const entry of accountFlows) countFlowPreference(entry, 'account');
    for (const machineEntry of machineEntries) {
        if (!machineEntry || typeof machineEntry !== 'object' || Array.isArray(machineEntry)) continue;
        const flows = (machineEntry as Record<string, unknown>).flows;
        if (!flows || typeof flows !== 'object' || Array.isArray(flows)) continue;
        for (const entry of Object.values(flows as Record<string, unknown>)) {
            countFlowPreference(entry, 'machine');
        }
    }

    return {
        machineCount: machineEntries.length,
        accountDirectOverrideCount,
        machineDirectOverrideCount,
        directEnabledCount,
        directDisabledCount,
    };
}

/** UI-only serializers for Protocol-owned runtime Account setting keys. */
export const ACCOUNT_RUNTIME_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    sessionReplaySummaryRunnerV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'presence',
        privacy: 'presence_only',
        identityScope: 'person',
        serializeCurrent: (value) => value !== null,
    },
    executionRunsGuidanceEntries: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildExecutionRunsGuidanceSummaryProperties,
    },
    peerMediationPreferencesV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildPeerMediationPreferencesSummaryProperties,
    },
    sessionTmuxByMachineId: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildSessionTmuxOverrideSummaryProperties,
    },
    sessionTmuxIsolated: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'boolean',
        privacy: 'safe',
        identityScope: 'person',
    },
    installablesPolicyByMachineId: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildInstallablesPolicySummaryProperties,
    },
    acpCatalogSettingsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildAcpCatalogSummaryProperties,
    },
});
