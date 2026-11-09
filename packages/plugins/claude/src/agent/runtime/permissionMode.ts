import { parsePermissionIntentAlias } from '@happier-dev/plugin-sdk/agents/runtime';
import { CLAUDE_NATIVE_PERMISSION_MODES, type ClaudeProviderPermissionMode } from '../permissionModes.js';

export type { ClaudeProviderPermissionMode } from '../permissionModes.js';

export type ClaudePermissionModeInput = Readonly<{
    permissionMode: string;
    agentModeId?: string | null | undefined;
}>;

type PermissionIntent = NonNullable<ReturnType<typeof parsePermissionIntentAlias>>;

/** Preserve live SDK mode switching without making ordinary root launches fail. */
export function shouldAllowClaudePermissionBypass(env: Readonly<Record<string, string | undefined>>): boolean {
    // Claude checks capability enablement too. Honor only existing child sandbox assertions.
    return process.platform === 'win32'
        || process.getuid?.() !== 0
        || env.IS_SANDBOX === '1'
        || env.CLAUDE_CODE_BUBBLEWRAP === '1';
}

export function mapToClaudePermissionMode(mode: string | null | undefined): ClaudeProviderPermissionMode {
    const mapping: Readonly<Record<string, ClaudeProviderPermissionMode>> = CLAUDE_NATIVE_PERMISSION_MODES;
    return typeof mode === 'string' && Object.hasOwn(mapping, mode) ? mapping[mode] : 'default';
}

/**
 * Build an explicit Claude permission override only when Happier selected a non-default mode.
 * Claude's `default` CLI flag overrides `permissions.defaultMode` from settings, so provider
 * default semantics require omitting the flag rather than spelling the default value.
 */
export function buildClaudePermissionModeArgs(mode: string | null | undefined): readonly string[] {
    const providerMode = mapToClaudePermissionMode(mode);
    return providerMode === 'default' ? [] : ['--permission-mode', providerMode];
}

export function resolveClaudePermissionModeFromRuntimeMode(mode: ClaudePermissionModeInput): ClaudeProviderPermissionMode {
    const agentModeId = typeof mode.agentModeId === 'string' ? mode.agentModeId.trim() : '';
    if (agentModeId === 'plan') return 'plan';
    return mapToClaudePermissionMode(mode.permissionMode);
}

export function inferPermissionIntentFromClaudeArgs(args?: readonly string[]): PermissionIntent | null {
    const input = args ?? [];
    let inferred: PermissionIntent | null = null;

    for (let index = 0; index < input.length; index += 1) {
        const arg = input[index];

        if (arg === '--dangerously-skip-permissions') {
            inferred = 'yolo';
            continue;
        }

        if (arg === '--permission-mode') {
            const next = index + 1 < input.length ? input[index + 1] : undefined;
            if (typeof next === 'string' && !next.startsWith('-')) {
                const parsed = parsePermissionIntentAlias(next);
                if (parsed) inferred = parsed;
                index += 1;
            }
            continue;
        }

        if (arg.startsWith('--permission-mode=')) {
            const rawValue = arg.slice('--permission-mode='.length).trim();
            if (rawValue) {
                const parsed = parsePermissionIntentAlias(rawValue);
                if (parsed) inferred = parsed;
            }
        }
    }

    return inferred;
}
