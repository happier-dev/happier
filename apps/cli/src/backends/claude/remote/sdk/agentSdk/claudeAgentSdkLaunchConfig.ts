import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { mapToClaudeMode, resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import { resolveClaudeEffortForModel } from '@/backends/claude/utils/claudeEffort';
import { resolveClaudeConfigDirEnvOverlay } from '@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay';
import { resolveClaudeCodeExperimentalEnvOverlay } from '@/backends/claude/spawn/resolveClaudeCodeExperimentalEnvOverlay';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';
import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';

import { parseExplicitSpawnEnvKeysFromProcessEnv } from './explicitSpawnEnvKeysMarker';

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
    onCompletionEvent?: (message: string) => void;
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
}>): Record<string, string> {
    const env = params.env ?? process.env;
    const explicitSpawnEnvKeys = new Set(parseExplicitSpawnEnvKeysFromProcessEnv(env));
    const allowExact = new Set<string>([
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
    ]);
    if (process.platform === 'win32') {
        for (const key of ['USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
            allowExact.add(key);
        }
    }
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
        if (explicitSpawnEnvKeys.has(key) || allowExact.has(key) || allowPrefixes.some((prefix) => key.startsWith(prefix))) {
            out[key] = value;
        }
    }

    delete out.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
    return {
        ...params.xdgIsolationEnv,
        ...out,
        ...resolveClaudeConfigDirEnvOverlay(params.claudeConfigDir ? { ...env, CLAUDE_CONFIG_DIR: params.claudeConfigDir } : env),
        ...params.experimentalEnvOverlay,
    };
}

export function resolveClaudeAgentSdkExtraArgs(params: Readonly<{
    enableFileCheckpointing: boolean;
    debugEnabled: boolean;
    verboseEnabled: boolean;
    debugCategories: readonly string[];
}>): Record<string, string | null> | undefined {
    const out: Record<string, string | null> = Object.create(null);
    if (params.enableFileCheckpointing) out['replay-user-messages'] = null;
    if (params.debugEnabled) out.debug = params.debugCategories.length > 0 ? params.debugCategories.join(',') : null;
    if (params.verboseEnabled) out.verbose = null;
    return Object.keys(out).length > 0 ? out : undefined;
}

export function applyClaudeAgentSdkAdvancedOptions(params: Readonly<{
    queryOptions: Record<string, unknown>;
    advancedOptions: Record<string, unknown> | null;
}>): void {
    if (!params.advancedOptions) return;

    const allowlistedKeys = [
        'plugins',
        'betas',
        'maxBudgetUsd',
        'sandbox',
        'additionalDirectories',
        'permissionPromptToolName',
        'tools',
        'systemPrompt',
        'debug',
        'debugFile',
        'stderr',
    ] as const;

    for (const key of allowlistedKeys) {
        if (!Object.prototype.hasOwnProperty.call(params.advancedOptions, key)) continue;
        const value = params.advancedOptions[key];
        if (key === 'stderr') {
            if (typeof value === 'function') params.queryOptions[key] = value;
            continue;
        }
        if (key === 'debugFile') {
            if (typeof value === 'string') params.queryOptions[key] = value;
            continue;
        }
        if (key === 'debug') {
            if (typeof value === 'boolean') params.queryOptions[key] = value;
            continue;
        }
        params.queryOptions[key] = value;
    }
}

export function getClaudeRemoteSystemPromptText(params: Readonly<{ mode: EnhancedMode }>): string {
    return getClaudeRemoteSystemPrompt({ disableTodos: params.mode.claudeRemoteDisableTodos === true });
}
