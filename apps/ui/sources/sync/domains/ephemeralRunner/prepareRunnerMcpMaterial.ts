import { resolveRunnerMcpMaterialV1, resolveRunnerMcpSelectionV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import type { RunnerMcpMaterialV1, RunnerMcpMaterializationFailureV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { readMcpServerCatalogInContext, McpServerCatalogOperationError, type McpServerCatalogAccountContext } from '@/sync/api/account/apiMcpServerCatalog';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { settingsParse } from '@/sync/domains/settings/settings';

export class RunnerMcpMaterializationUnavailableError extends Error {
    constructor(readonly failure: RunnerMcpMaterializationFailureV1) {
        super(`runner_mcp_${failure.reason}_${failure.serverId}`);
        this.name = 'RunnerMcpMaterializationUnavailableError';
    }
}

/** Resolves only the selected MCP values into creator custody for endpoint sealing. */
export async function prepareRunnerMcpMaterial(input: Readonly<{
    context: McpServerCatalogAccountContext;
    selection: SessionMcpSelectionV1 | null;
    signal?: AbortSignal;
}>): Promise<RunnerMcpMaterialV1 | null> {
    const { context, signal } = input;
    context.assertCurrent();
    const catalog = await readMcpServerCatalogInContext(context, signal);
    if (catalog.status !== 'ready' || catalog.authority !== 'active') {
        throw new McpServerCatalogOperationError(catalog.status === 'unavailable'
            ? catalog.reason : catalog.status === 'partial' ? 'invalid-stored-content' : 'authority-not-confirmed');
    }
    // Activation may extract policy into Settings. The caller's pre-admission
    // projection is not the fresh source baseline for this reviewed package.
    const { accountMode, encryption } = await context.resolveAccountEncryption();
    const baseline = await readAccountSettingsBaseline({ credentials: context.credentials, accountMode, encryption,
        request: (path, init) => context.request(path, { ...init, signal }, { retry: 'none' }) });
    context.assertCurrent();
    const selected = resolveRunnerMcpSelectionV1({ settings: { ...catalog.catalog,
        strictMode: settingsParse(baseline.raw).mcpServersStrictMode === true }, selection: input.selection });
    if (!selected.ok) throw new RunnerMcpMaterializationUnavailableError(selected);
    const references = [...new Set(listMcpServerCatalogSavedSecretRefsV1({ v: 1,
        servers: selected.selectedServers.map(server => server.config), bindings: [] }).map(reference => reference.secretId))];
    const material = new Map(await Promise.all(references.map(async reference => {
        const read = await readSavedSecretReferenceInContext(context, reference, signal);
        return [reference, read.ok ? { value: read.value, revision: read.revision } : null] as const;
    })));
    context.assertCurrent();
    const resolved = resolveRunnerMcpMaterialV1({
        settings: selected.settings,
        selection: selected.selection,
        resolveSavedSecret: reference => material.get(reference) ?? null,
    });
    if (!resolved.ok) throw new RunnerMcpMaterializationUnavailableError(resolved);
    return resolved.material.servers.length === 0 ? null : resolved.material;
}
