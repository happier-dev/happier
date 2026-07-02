import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';
import { mapToClaudeMode, resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import { resolveClaudeConfigDirEnvOverlay } from '@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay';
import { isolateClaudeRuntimeAuthEnv } from '@happier-dev/plugins-claude/agent/auth/services/runtime';
import { resolveClaudeCodeExperimentalEnvOverlay } from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';
import { resolveClaudeEffortForModel } from '@happier-dev/plugins-claude/agent/runtime/reasoningEffort';
import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
    HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR,
    parseExplicitSpawnEnvKeysFromProcessEnv,
} from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

export type ClaudeSdkFlagOverrides = Readonly<{
    model?: string;
    fallbackModel?: string;
    effort?: string;
    maxTurns?: number;
    strictMcpConfig?: boolean;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
}>;

export type RuntimeSettingsSnapshot = Readonly<{
    permissionMode: string;
    model: string | null;
    maxThinkingTokens: number | null | undefined;
}>;

export type ClaudeRemoteSdkLaunchSettings = Readonly<{
    customSystemPrompt: string | undefined;
    appendSystemPrompt: string | undefined;
    enableFileCheckpointing: boolean;
    debugEnabled: boolean;
    verboseEnabled: boolean;
    debugCategories: string[];
    settingSources: readonly ('user' | 'project' | 'local')[];
    advancedOptions: Record<string, unknown> | null;
    mappedPermissionMode: string;
    resumeSessionAt: string | null;
    resolvedEffort: string | null;
    experimentalEnvOverlay: Record<string, string>;
    xdgIsolationEnv: Record<string, string>;
}>;

export function resolveClaudeRemoteSdkLaunchSettings(params: Readonly<{
    mode: EnhancedMode;
    argOverrides: ClaudeSdkFlagOverrides;
    sessionId: string | null;
    resumeSessionAt?: string | null;
    onCompletionEvent?: (message: ClaudeCompletionEvent) => void;
}>): ClaudeRemoteSdkLaunchSettings {
    const { mode, argOverrides } = params;
    const customSystemPrompt = argOverrides.customSystemPrompt ?? mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? mode.appendSystemPrompt;
    const enableFileCheckpointing = mode.claudeRemoteEnableFileCheckpointing === true;
    const debugEnabled = mode.claudeRemoteDebugEnabled === true;
    const verboseEnabled = mode.claudeRemoteVerboseEnabled === true;
    const debugCategories = (() => {
        const raw = mode.claudeRemoteDebugCategories;
        if (!Array.isArray(raw)) return [] as string[];
        const set = new Set<string>();
        for (const value of raw) {
            set.add(value);
        }
        const out: string[] = [];
        for (const key of ['api', 'mcp', 'hooks', 'file', '1p'] as const) {
            if (set.has(key)) out.push(key);
        }
        return out;
    })();
    const settingSources = (() => {
        type SettingSource = 'user' | 'project' | 'local';

        const rawV2 = (mode as any).claudeRemoteSettingSourcesV2 as unknown;
        if (Array.isArray(rawV2)) {
            const set = new Set<string>();
            for (const value of rawV2) {
                if (typeof value === 'string') set.add(value);
            }
            const normalized: SettingSource[] = [];
            for (const key of ['user', 'project', 'local'] as const) {
                if (set.has(key)) normalized.push(key);
            }

            if (normalized.length === 0) return [];
            if (normalized.length === 3) return ['user', 'project', 'local'] as const;
            return normalized;
        }

        const value = mode.claudeRemoteSettingSources;
        if (value === 'user_project') return ['user', 'project'] as const;
        if (value === 'project') return ['project'] as const;
        if (value === 'none') return [];
        return ['user', 'project', 'local'] as const;
    })();
    const advancedOptionsJsonRaw = typeof mode.claudeRemoteAdvancedOptionsJson === 'string'
        ? mode.claudeRemoteAdvancedOptionsJson.trim()
        : '';
    let advancedOptions: Record<string, unknown> | null = null;
    if (advancedOptionsJsonRaw.length > 0) {
        try {
            const parsed = JSON.parse(advancedOptionsJsonRaw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                advancedOptions = parsed as Record<string, unknown>;
            } else {
                params.onCompletionEvent?.('Invalid advanced Claude options JSON (must be an object); ignoring.');
            }
        } catch {
            params.onCompletionEvent?.('Invalid advanced Claude options JSON; ignoring.');
        }
    }

    const mappedPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(mode);
    const experimentalEnvOverlay = resolveClaudeCodeExperimentalEnvOverlay({
        claudeCodeExperimentalAgentTeamsEnabled: mode.claudeCodeExperimentalAgentTeamsEnabled,
    });
    const xdgIsolationEnv = resolveClaudeCodeXdgIsolation({
        backendId: 'claude',
        scope: 'session',
        isolationId:
            typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
                ? params.sessionId.trim()
                : `pid_${process.pid}`,
    });
    const normalizedResumeSessionAt =
        typeof params.resumeSessionAt === 'string' && params.resumeSessionAt.trim().length > 0
            ? params.resumeSessionAt.trim()
            : null;
    const resolvedEffort = resolveClaudeEffortForModel({
        modelId: argOverrides.model ?? mode.model,
        effort: argOverrides.effort ?? mode.reasoningEffort,
    });

    return {
        customSystemPrompt,
        appendSystemPrompt,
        enableFileCheckpointing,
        debugEnabled,
        verboseEnabled,
        debugCategories,
        settingSources,
        advancedOptions,
        mappedPermissionMode,
        resumeSessionAt: normalizedResumeSessionAt,
        resolvedEffort,
        experimentalEnvOverlay,
        xdgIsolationEnv,
    };
}

export function resolveDesiredRuntimeSettingsSnapshot(params: Readonly<{
    resolvedMode: EnhancedMode;
    argOverrides: ClaudeSdkFlagOverrides;
}>): RuntimeSettingsSnapshot {
    const permissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(params.resolvedMode);
    const model =
        typeof params.argOverrides.model === 'string'
            ? params.argOverrides.model
            : typeof params.resolvedMode.model === 'string'
                ? params.resolvedMode.model
                : null;

    const maxThinkingTokens =
        typeof params.resolvedMode.claudeRemoteMaxThinkingTokens === 'number'
            || params.resolvedMode.claudeRemoteMaxThinkingTokens === null
            ? params.resolvedMode.claudeRemoteMaxThinkingTokens
            : undefined;

    return { permissionMode, model, maxThinkingTokens };
}

export async function applyRuntimeSettingsUpdatesIfNeeded(params: Readonly<{
    response: any;
    lastApplied: RuntimeSettingsSnapshot;
    next: RuntimeSettingsSnapshot;
}>): Promise<RuntimeSettingsSnapshot> {
    let lastApplied = params.lastApplied;

    if (params.next.permissionMode !== lastApplied.permissionMode) {
        await params.response?.setPermissionMode?.(params.next.permissionMode);
        lastApplied = { ...lastApplied, permissionMode: params.next.permissionMode };
    }

    if (params.next.model !== lastApplied.model) {
        await params.response?.setModel?.(params.next.model ?? undefined);
        lastApplied = { ...lastApplied, model: params.next.model };
    }

    if (params.next.maxThinkingTokens !== lastApplied.maxThinkingTokens && params.next.maxThinkingTokens !== undefined) {
        await params.response?.setMaxThinkingTokens?.(params.next.maxThinkingTokens ?? null);
        lastApplied = { ...lastApplied, maxThinkingTokens: params.next.maxThinkingTokens };
    }

    return lastApplied;
}

export function buildClaudeAgentSdkSubprocessEnv(params: Readonly<{
    claudeConfigDir: string | null;
    xdgIsolationEnv: Record<string, string>;
    experimentalEnvOverlay: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}>): Record<string, string> {
    const env = params.env ?? process.env;
    const platform = params.platform ?? process.platform;
    const explicitSpawnEnvKeys = new Set(parseExplicitSpawnEnvKeysFromProcessEnv(env));
    const allowExact = [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TERM',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SSH_AUTH_SOCK',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        '__CF_USER_TEXT_ENCODING',
        'HAPPIER_E2E_FAKE_CLAUDE_LOG',
        'HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID',
        'HAPPY_E2E_FAKE_CLAUDE_LOG',
        'HAPPY_E2E_FAKE_CLAUDE_SESSION_ID',
    ];
    if (platform === 'win32') {
        for (const key of ['USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
            allowExact.push(key);
        }
    }
    const allowExactKeys = createAllowedEnvKeySet(allowExact, platform);
    const allowPrefixes = [
        'XDG_',
        'CLAUDE_',
        'ANTHROPIC_',
        'FORCE_COLOR',
        'NO_COLOR',
        'COLORTERM',
        'TERM_',
        'HAPPIER_E2E_',
        'HAPPY_E2E_',
    ];

    const out: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(env)) {
        if (!isValidEnvVarKey(key)) continue;
        if (typeof value !== 'string') continue;
        if (explicitSpawnEnvKeys.has(key) || isAllowedEnvKey(key, allowExactKeys, platform) || allowPrefixes.some((prefix) => key.startsWith(prefix))) {
            out[key] = value;
        }
    }

    const connectedServiceSelections = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    if (typeof connectedServiceSelections === 'string') {
        out[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = connectedServiceSelections;
    }

    const materializedEnvKeys = env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY];
    if (typeof materializedEnvKeys === 'string') {
        out[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY] = materializedEnvKeys;
    }

    delete out[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR];
    return isolateClaudeRuntimeAuthEnv({
        ...params.xdgIsolationEnv,
        ...out,
        ...resolveClaudeConfigDirEnvOverlay(params.claudeConfigDir ? { ...env, CLAUDE_CONFIG_DIR: params.claudeConfigDir } : env),
        ...params.experimentalEnvOverlay,
    });
}

export function getClaudeRemoteSystemPromptText(params: Readonly<{ mode: EnhancedMode }>): string {
    return getClaudeRemoteSystemPrompt({ disableTodos: params.mode.claudeRemoteDisableTodos === true });
}
