import { McpServersSettingsV1Schema, buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';

function countSavedSecretRefs(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;

    const record = value as Record<string, unknown>;
    if (record.t === 'savedSecret' && typeof record.secretId === 'string' && record.secretId.length > 0) {
        return 1;
    }

    let total = 0;
    for (const nestedValue of Object.values(record)) {
        if (Array.isArray(nestedValue)) {
            for (const arrayValue of nestedValue) {
                total += countSavedSecretRefs(arrayValue);
            }
            continue;
        }
        total += countSavedSecretRefs(nestedValue);
    }

    return total;
}

function buildMcpSummaryProperties(value: unknown): Record<string, boolean | number> {
    const settings =
        value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    const servers = Array.isArray(settings.servers) ? settings.servers : [];
    const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];

    let stdioCount = 0;
    let httpCount = 0;
    let sseCount = 0;
    let enabledBindingCount = 0;
    let allMachinesCount = 0;
    let machineTargetCount = 0;
    let workspaceTargetCount = 0;
    let overridePresenceCount = 0;
    let savedSecretRefCount = 0;

    for (const server of servers) {
        if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
        const serverRecord = server as Record<string, unknown>;

        if (serverRecord.transport === 'stdio') stdioCount += 1;
        if (serverRecord.transport === 'http') httpCount += 1;
        if (serverRecord.transport === 'sse') sseCount += 1;

        savedSecretRefCount += countSavedSecretRefs(serverRecord.env);
        if (
            serverRecord.remote
            && typeof serverRecord.remote === 'object'
            && !Array.isArray(serverRecord.remote)
        ) {
            savedSecretRefCount += countSavedSecretRefs((serverRecord.remote as Record<string, unknown>).headers);
        }
    }

    for (const binding of bindings) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
        const bindingRecord = binding as Record<string, unknown>;

        if (bindingRecord.enabled === true) enabledBindingCount += 1;
        if (bindingRecord.target && typeof bindingRecord.target === 'object' && !Array.isArray(bindingRecord.target)) {
            const targetRecord = bindingRecord.target as Record<string, unknown>;
            if (targetRecord.t === 'allMachines') allMachinesCount += 1;
            if (targetRecord.t === 'machine') machineTargetCount += 1;
            if (targetRecord.t === 'workspace') workspaceTargetCount += 1;
        }
        if (
            bindingRecord.overrides
            && typeof bindingRecord.overrides === 'object'
            && !Array.isArray(bindingRecord.overrides)
            && Object.keys(bindingRecord.overrides as Record<string, unknown>).length > 0
        ) {
            overridePresenceCount += 1;
            savedSecretRefCount += countSavedSecretRefs(bindingRecord.overrides);
        }
    }

    return {
        strictMode: settings.strictMode === true,
        serverCount: servers.length,
        stdioCount,
        httpCount,
        sseCount,
        bindingCount: bindings.length,
        enabledBindingCount,
        allMachinesCount,
        machineTargetCount,
        workspaceTargetCount,
        overridePresenceCount,
        savedSecretRefCount,
    };
}

export const ACCOUNT_MCP_SETTING_DEFINITIONS = defineSettingDefinitions({
    mcpServersSettingsV1: {
        schema: McpServersSettingsV1Schema.default({ v: 1, strictMode: false, servers: [], bindings: [] }),
        default: { v: 1, strictMode: false, servers: [], bindings: [] },
        description: 'Stored MCP server catalog and bindings',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildMcpSummaryProperties,
        },
    },
});

export const ACCOUNT_MCP_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_MCP_SETTING_DEFINITIONS);
