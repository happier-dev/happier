import { AcpCatalogSettingsV1Schema, BackendTargetRefSchema, LlmTaskRunnerConfigV1Schema, buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';
import { isAgentId } from '@/agents/registry/registryCore';

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

export const SessionTmuxMachineOverrideSchema = z.object({
    useTmux: z.boolean(),
    sessionName: z.string(),
    isolated: z.boolean(),
    tmpDir: z.string().nullable(),
});

export const InstallableAutoUpdateModeSchema = z.enum(['off', 'notify', 'auto']);

export const InstallablePolicySchema = z.object({
    autoInstallWhenNeeded: z.boolean().optional(),
    autoUpdateMode: InstallableAutoUpdateModeSchema.optional(),
});

export const InstallablesPolicyByMachineIdSchema = z.record(
    z.string(),
    z.record(z.string(), InstallablePolicySchema).default({}),
).default({});

export const ExecutionRunsGuidanceEntrySchema = z.object({
    id: z.string().min(1),
    title: z.string().max(200).optional(),
    description: z.string().min(1).max(10_000),
    enabled: z.boolean().default(true),
    suggestedBackendTarget: BackendTargetRefSchema.optional(),
    suggestedModelId: z.string().min(1).max(200).optional(),
    suggestedIntent: z.enum(['review', 'plan', 'delegate']).optional(),
    exampleToolCalls: z.array(z.string()).optional(),
}).superRefine((value, ctx) => {
    const target = value.suggestedBackendTarget;
    if (!target || target.kind !== 'builtInAgent') return;
    if (isAgentId(target.agentId)) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestedBackendTarget', 'agentId'],
        message: 'Unknown built-in backend target',
    });
});

export const ACCOUNT_RUNTIME_SETTING_DEFINITIONS = defineSettingDefinitions({
    sessionReplaySummaryRunnerV1: {
        schema: LlmTaskRunnerConfigV1Schema.nullable(),
        default: null,
        description: 'Runner used for on-demand replay summaries (summary_plus_recent)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'presence',
            privacy: 'presence_only',
            identityScope: 'person',
            serializeCurrent: (value: z.infer<typeof LlmTaskRunnerConfigV1Schema> | null): boolean => value !== null,
        },
    },
    executionRunsGuidanceEntries: {
        schema: z.array(ExecutionRunsGuidanceEntrySchema),
        default: [],
        description: 'User-configured execution-run guidance entries',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildExecutionRunsGuidanceSummaryProperties,
        },
    },
    sessionTmuxByMachineId: {
        schema: z.record(z.string(), SessionTmuxMachineOverrideSchema).default({}),
        default: {},
        description: 'Per-machine overrides for tmux session spawning',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildSessionTmuxOverrideSummaryProperties,
        },
    },
    sessionTmuxSessionName: {
        schema: z.string(),
        default: 'happy',
        description: 'Default tmux session name for new sessions',
        storageScope: 'account',
    },
    sessionTmuxIsolated: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to use an isolated tmux server for new sessions',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'boolean',
            privacy: 'safe',
            identityScope: 'person',
        },
    },
    sessionTmuxTmpDir: {
        schema: z.string().nullable(),
        default: null,
        description: 'Optional TMUX_TMPDIR override for isolated tmux server',
        storageScope: 'account',
    },
    installablesPolicyByMachineId: {
        schema: InstallablesPolicyByMachineIdSchema,
        default: {},
        description: 'Per-machine installables policy overrides (auto-install / auto-update)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildInstallablesPolicySummaryProperties,
        },
    },
    acpCatalogSettingsV1: {
        schema: AcpCatalogSettingsV1Schema.catch({ v: 2, backends: [] }).default({ v: 2, backends: [] }),
        default: { v: 2, backends: [] },
        description: 'Configured ACP backends',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildAcpCatalogSummaryProperties,
        },
    },
});

export const ACCOUNT_RUNTIME_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_RUNTIME_SETTING_DEFINITIONS);
