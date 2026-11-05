import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { CODEX_SUPPORTED_RUNTIME_VERSION, CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY } from '../../../cli/supportedRuntime.js';
import type { DisposableCodexAppServerClient } from '../client.js';
import { codexProcessExitedSuccessfully } from '../connection.js';

/** Verification consumes an initialized client; it never owns native admission. */
export async function readCodexToolRestrictionEvidence(params: Readonly<{
    client: DisposableCodexAppServerClient;
    exec: ExecService;
    executable: ManagedExecutableRef;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
    configOverrides?: readonly string[];
    cwd?: string;
    allowedMcpServerKeys?: readonly string[];
    signal?: AbortSignal;
}>): Promise<Pick<DisposableCodexAppServerClient['launchFeatures'], 'toolRestrictionSupportedModelIds'>> {
    if (params.client.launchFeatures.nativeVersion !== CODEX_SUPPORTED_RUNTIME_VERSION) {
        throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY });
    }
    const effective = await params.client.request('config/read', { includeLayers: false, ...(params.cwd ? { cwd: params.cwd } : {}) });
    const config = effective && typeof effective === 'object' ? (effective as { config?: unknown }).config : null;
    const features = config && typeof config === 'object' ? (config as { features?: unknown }).features : null;
    const codeMode = features && typeof features === 'object' ? (features as { code_mode?: unknown }).code_mode : null;
    const excluded = codeMode && typeof codeMode === 'object' ? (codeMode as { excluded_tool_namespaces?: unknown }).excluded_tool_namespaces : null;
    if (!Array.isArray(excluded) || !excluded.includes('functions')) {
        throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex did not apply its native tool-namespace exclusion.' });
    }
    const mcpServers = config && typeof config === 'object' ? (config as { mcp_servers?: unknown }).mcp_servers : null;
    const allowedServerKeys = new Set(params.allowedMcpServerKeys ?? []);
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers) || Object.entries(mcpServers).some(([key, value]) => (
        !allowedServerKeys.has(key) && (!value || typeof value !== 'object' || (value as { enabled?: unknown }).enabled !== false)
    ))) {
        throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex has enabled MCP servers outside the host-selected recipe.' });
    }
    const result = await params.exec.run({
        executable: params.executable,
        args: ['debug', 'models'],
        cwd: { root: 'workspace', relativePath: '' },
        env: params.env,
        timeoutMs: params.timeoutMs,
    }, params.signal ? { signal: params.signal } : undefined);
    let models: unknown;
    if (codexProcessExitedSuccessfully(result) && result.stdoutTruncated === false && result.stderrTruncated === false) {
        try { models = (JSON.parse(new TextDecoder().decode(result.stdout)) as { models?: unknown }).models; } catch { /* Malformed evidence is unsupported. */ }
    }
    if (!Array.isArray(models)) {
        throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex did not provide its native tool-mode catalog.' });
    }
    return {
        toolRestrictionSupportedModelIds: models.flatMap((model: unknown) => {
            if (!model || typeof model !== 'object') return [];
            const entry = model as Readonly<{ slug?: unknown; tool_mode?: unknown }>;
            return typeof entry.slug === 'string' && entry.tool_mode === 'code_mode_only' ? [entry.slug] : [];
        }),
    };
}
