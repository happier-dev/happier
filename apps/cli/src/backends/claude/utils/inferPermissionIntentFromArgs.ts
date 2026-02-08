import type { PermissionIntent } from '@happier-dev/agents';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

/**
 * Infer the canonical permission intent from Claude Code CLI args.
 *
 * This is used for local terminal-started sessions where the user may pass Claude-native flags
 * (e.g. `--dangerously-skip-permissions`, `--permission-mode acceptEdits`).
 *
 * Returns `null` when no supported flag is found.
 */
export function inferPermissionIntentFromClaudeArgs(args?: string[]): PermissionIntent | null {
    const input = args ?? [];
    let inferred: PermissionIntent | null = null;

    for (let i = 0; i < input.length; i++) {
        const arg = input[i];

        if (arg === '--dangerously-skip-permissions') {
            inferred = 'yolo';
            continue;
        }

        if (arg === '--permission-mode') {
            const next = i + 1 < input.length ? input[i + 1] : undefined;
            if (next && !next.startsWith('-')) {
                const parsed = parsePermissionIntentAlias(next);
                if (parsed) inferred = parsed;
                i++; // consume value
            }
            continue;
        }
    }

    return inferred;
}

