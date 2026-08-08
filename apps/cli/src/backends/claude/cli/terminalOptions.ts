import type { EnhancedMode } from '@/backends/claude/loop';
import { buildClaudeEffortCliArgs, resolveClaudeUltracodeForModel } from '@/backends/claude/utils/claudeEffort';
import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import { parseClaudeSdkFlagOverridesFromArgs } from '@/backends/claude/remote/sdkFlagOverrides';

export type ClaudeTerminalCliOptionsDiagnosticCode =
    | 'invalid_advanced_options_json'
    | 'unsupported_advanced_option'
    | 'unsupported_empty_setting_sources'
    | 'unsupported_max_thinking_tokens'
    | 'unsupported_strict_mcp_config';

export type ClaudeTerminalCliOptionsDiagnostic = Readonly<{
    code: ClaudeTerminalCliOptionsDiagnosticCode;
    option?: string;
}>;

export type ClaudeTerminalCliOptions = Readonly<{
    extraArgs: readonly string[];
    customSystemPrompt: string;
    appendSystemPrompt: string;
    /**
     * Resolved session-only ultracode setting (requested AND xhigh-capable model).
     *
     * Not emitted as a CLI arg here: ultracode must ride the single `--settings` overlay,
     * which the spawn builder owns (it merges this into the hook settings overlay).
     */
    ultracodeEnabled: boolean;
    diagnostics: readonly ClaudeTerminalCliOptionsDiagnostic[];
}>;

type SettingSource = 'user' | 'project' | 'local';

const SETTING_SOURCE_ORDER = ['user', 'project', 'local'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizedStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed);
    }
    return out;
}

function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function resolveSettingSourcesArgs(mode: EnhancedMode, diagnostics: ClaudeTerminalCliOptionsDiagnostic[]): string[] {
    const rawV2 = mode.claudeRemoteSettingSourcesV2;
    if (Array.isArray(rawV2)) {
        const set = new Set<string>();
        for (const value of rawV2) {
            if (typeof value === 'string') set.add(value);
        }
        const normalized: SettingSource[] = [];
        for (const key of SETTING_SOURCE_ORDER) {
            if (set.has(key)) normalized.push(key);
        }
        if (normalized.length === 3) return [];
        if (normalized.length === 0) {
            diagnostics.push({ code: 'unsupported_empty_setting_sources', option: 'claudeRemoteSettingSourcesV2' });
            return [];
        }
        return ['--setting-sources', normalized.join(',')];
    }

    const legacy = mode.claudeRemoteSettingSources;
    if (legacy === 'project') return ['--setting-sources', 'project'];
    if (legacy === 'user_project') return ['--setting-sources', 'user,project'];
    if (legacy === 'none') {
        diagnostics.push({ code: 'unsupported_empty_setting_sources', option: 'claudeRemoteSettingSources' });
    }
    return [];
}

function appendPluginArgs(value: unknown, out: string[], diagnostics: ClaudeTerminalCliOptionsDiagnostic[]): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
        const plugin = asRecord(item);
        if (!plugin) continue;
        const type = typeof plugin.type === 'string' ? plugin.type : '';
        const path = typeof plugin.path === 'string' ? plugin.path.trim() : '';
        const url = typeof plugin.url === 'string' ? plugin.url.trim() : '';
        if (type === 'local' && path) {
            out.push('--plugin-dir', path);
            continue;
        }
        if ((type === 'remote' || type === 'url') && url) {
            out.push('--plugin-url', url);
            continue;
        }
        diagnostics.push({ code: 'unsupported_advanced_option', option: 'plugins' });
    }
}

function appendAdvancedOptionsArgs(
    advancedOptions: Record<string, unknown>,
    out: string[],
    diagnostics: ClaudeTerminalCliOptionsDiagnostic[],
): void {
    const consumed = new Set<string>();

    if (Object.prototype.hasOwnProperty.call(advancedOptions, 'plugins')) {
        consumed.add('plugins');
        appendPluginArgs(advancedOptions.plugins, out, diagnostics);
    }

    const betas = normalizedStringArray(advancedOptions.betas);
    if (betas.length > 0) {
        consumed.add('betas');
        out.push('--betas', ...betas);
    }

    const additionalDirectories = normalizedStringArray(advancedOptions.additionalDirectories);
    if (additionalDirectories.length > 0) {
        consumed.add('additionalDirectories');
        out.push('--add-dir', ...additionalDirectories);
    }

    const tools = Array.isArray(advancedOptions.tools)
        ? normalizedStringArray(advancedOptions.tools).join(',')
        : typeof advancedOptions.tools === 'string'
            ? advancedOptions.tools.trim()
            : '';
    if (tools) {
        consumed.add('tools');
        out.push('--tools', tools);
    }

    if (advancedOptions.debug === true) {
        consumed.add('debug');
        out.push('--debug');
    }

    if (typeof advancedOptions.debugFile === 'string' && advancedOptions.debugFile.trim()) {
        consumed.add('debugFile');
        out.push('--debug-file', advancedOptions.debugFile.trim());
    }

    if (typeof advancedOptions.maxBudgetUsd === 'number' && Number.isFinite(advancedOptions.maxBudgetUsd)) {
        consumed.add('maxBudgetUsd');
        out.push('--max-budget-usd', String(advancedOptions.maxBudgetUsd));
    }

    for (const key of Object.keys(advancedOptions).sort()) {
        if (consumed.has(key)) continue;
        diagnostics.push({ code: 'unsupported_advanced_option', option: key });
    }
}

function parseAdvancedOptions(
    raw: unknown,
    diagnostics: ClaudeTerminalCliOptionsDiagnostic[],
): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        const record = asRecord(parsed);
        if (!record) {
            diagnostics.push({ code: 'invalid_advanced_options_json', option: 'claudeRemoteAdvancedOptionsJson' });
            return null;
        }
        return record;
    } catch {
        diagnostics.push({ code: 'invalid_advanced_options_json', option: 'claudeRemoteAdvancedOptionsJson' });
        return null;
    }
}

export function resolveClaudeTerminalCliOptions(params: Readonly<{
    mode: EnhancedMode;
    claudeArgs?: readonly string[];
    supportsStrictMcpConfig?: boolean;
}>): ClaudeTerminalCliOptions {
    const diagnostics: ClaudeTerminalCliOptionsDiagnostic[] = [];
    const extraArgs: string[] = [];
    const argOverrides = parseClaudeSdkFlagOverridesFromArgs([...(params.claudeArgs ?? [])]);

    const effectiveModel = normalizeString(argOverrides.model) || normalizeString(params.mode.model);
    const effectiveFallbackModel = normalizeString(argOverrides.fallbackModel) || normalizeString(params.mode.fallbackModel);
    const customSystemPrompt = normalizeString(argOverrides.customSystemPrompt) || normalizeString(params.mode.customSystemPrompt);
    const modeAppendSystemPrompt = normalizeString(argOverrides.appendSystemPrompt) || normalizeString(params.mode.appendSystemPrompt);

    extraArgs.push(...buildClaudeEffortCliArgs({
        modelId: effectiveModel,
        effort: argOverrides.effort ?? params.mode.reasoningEffort,
        supportedLevels: params.mode.modelEffortLevels,
    }));
    if (effectiveModel) {
        extraArgs.push('--model', effectiveModel);
    }
    if (effectiveFallbackModel && effectiveFallbackModel !== effectiveModel) {
        extraArgs.push('--fallback-model', effectiveFallbackModel);
    }
    extraArgs.push(...resolveSettingSourcesArgs(params.mode, diagnostics));

    const wantsStrictMcpConfig = params.mode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig === true;
    if (wantsStrictMcpConfig) {
        if (params.supportsStrictMcpConfig === false) {
            diagnostics.push({ code: 'unsupported_strict_mcp_config', option: 'claudeRemoteStrictMcpServerConfig' });
        } else {
            extraArgs.push('--strict-mcp-config');
        }
    }

    if (typeof params.mode.claudeRemoteMaxThinkingTokens === 'number') {
        diagnostics.push({ code: 'unsupported_max_thinking_tokens', option: 'claudeRemoteMaxThinkingTokens' });
    }

    const advancedOptions = parseAdvancedOptions(params.mode.claudeRemoteAdvancedOptionsJson, diagnostics);
    if (advancedOptions) {
        appendAdvancedOptionsArgs(advancedOptions, extraArgs, diagnostics);
    }

    const appendSystemPrompt = [
        modeAppendSystemPrompt,
        params.mode.claudeRemoteDisableTodos === true
            ? getClaudeRemoteSystemPrompt({ disableTodos: true })
            : '',
    ].filter(Boolean).join('\n\n');

    return Object.freeze({
        extraArgs: Object.freeze([...extraArgs]),
        customSystemPrompt,
        appendSystemPrompt,
        ultracodeEnabled: resolveClaudeUltracodeForModel({
            modelId: effectiveModel,
            ultracode: params.mode.ultracode,
            supportedLevels: params.mode.modelEffortLevels,
        }),
        diagnostics: Object.freeze([...diagnostics]),
    });
}
