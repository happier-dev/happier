import type { PermissionMode, PermissionModeGroupId as SharedPermissionModeGroupId } from '@happier-dev/agents';
import { PERMISSION_MODES } from '@happier-dev/agents';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export type { PermissionMode } from '@happier-dev/agents';

// We keep the user-facing intents consistent across agents. Providers that cannot enforce
// certain intents (e.g. Claude "read-only") are handled via effective-policy mapping.
export const CLAUDE_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo', 'plan'] as const;
export const CODEX_LIKE_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const;

const CLAUDE_PERMISSION_MODE_CYCLE = ['default', 'safe-yolo', 'yolo', 'plan'] as const;

export type PermissionModeGroupId = SharedPermissionModeGroupId;

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizePermissionModeForGroup(mode: PermissionMode, group: PermissionModeGroupId): PermissionMode {
    const normalized = (parsePermissionIntentAlias(mode) ?? 'default') as PermissionMode;

    if (group === 'codexLike') {
        if (normalized === 'plan') return 'read-only';
        return (CODEX_LIKE_PERMISSION_MODES as readonly string[]).includes(normalized)
            ? normalized
            : 'default';
    }

    return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(normalized)
        ? normalized
        : 'default';
}

export function getNextPermissionModeForGroup(mode: PermissionMode, group: PermissionModeGroupId): PermissionMode {
    if (group === 'codexLike') {
        const normalized = (parsePermissionIntentAlias(mode) ?? 'default') as (typeof CODEX_LIKE_PERMISSION_MODES)[number];
        const currentIndex = CODEX_LIKE_PERMISSION_MODES.indexOf(normalized);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = (safeIndex + 1) % CODEX_LIKE_PERMISSION_MODES.length;
        return CODEX_LIKE_PERMISSION_MODES[nextIndex];
    }

    // Claude cannot enforce read-only as a provider-native permission mode, but we still keep it
    // as a user-facing intent in other surfaces. When cycling, treat read-only as default.
    const normalizedRaw = parsePermissionIntentAlias(mode) ?? 'default';
    const normalized = (normalizedRaw === 'read-only' ? 'default' : normalizedRaw) as (typeof CLAUDE_PERMISSION_MODE_CYCLE)[number];
    const currentIndex = CLAUDE_PERMISSION_MODE_CYCLE.indexOf(normalized);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeIndex + 1) % CLAUDE_PERMISSION_MODE_CYCLE.length;
    return CLAUDE_PERMISSION_MODE_CYCLE[nextIndex];
}

export function normalizeProfileDefaultPermissionMode(mode: PermissionMode | null | undefined): PermissionMode {
    if (!mode) return 'default';
    return mode;
}

// NOTE: Model IDs can be provider-defined (especially for ACP agents advertising models dynamically).
// Keep the runtime representation flexible and validate known models separately where needed.
export type ModelMode = string;

export function isModelMode(value: unknown): value is ModelMode {
    return typeof value === 'string' && value.trim().length > 0;
}
