import { parsePermissionIntentAlias } from '@happier-dev/plugin-sdk/experimental/acp';

export type ClaudeProviderPermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'dontAsk'
    | 'auto';

export type ClaudePermissionModeInput = Readonly<{
    permissionMode: string;
    agentModeId?: string | null | undefined;
}>;

type PermissionIntent = NonNullable<ReturnType<typeof parsePermissionIntentAlias>>;

export function mapToClaudePermissionMode(mode: string | null | undefined): ClaudeProviderPermissionMode {
    if (mode === 'yolo') return 'bypassPermissions';
    if (mode === 'safe-yolo') return 'auto';
    if (mode === 'read-only') return 'dontAsk';
    if (
        mode === 'default'
        || mode === 'acceptEdits'
        || mode === 'bypassPermissions'
        || mode === 'plan'
        || mode === 'dontAsk'
        || mode === 'auto'
    ) {
        return mode;
    }
    return 'default';
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
