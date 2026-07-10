import { PERMISSION_INTENTS, PERMISSION_MODES, type PermissionIntent, type PermissionMode } from '../types.js';
import type { AgentId } from '../types.js';
import { getAgentSessionModeDescriptor, type AgentSessionModeDescriptor } from '../sessionModes.js';

export { PERMISSION_MODES };
export type { PermissionIntent, PermissionMode };

function normalizeToken(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isPermissionIntent(value: unknown): value is PermissionIntent {
    return typeof value === 'string' && (PERMISSION_INTENTS as readonly string[]).includes(value);
}

export type PermissionModeGroupId = 'claude' | 'codexLike';

export function normalizePermissionModeForGroup(mode: PermissionMode, _group: PermissionModeGroupId): PermissionMode {
    const normalized = parsePermissionIntentAlias(mode) ?? 'default';

    // `plan` is an agent behavior mode, not permission strictness. Fail it closed at this layer.
    if (normalized === 'plan') return 'read-only';

    return normalized;
}

export function resolvePermissionModeGroupForSessionModeDescriptor(
    descriptor: AgentSessionModeDescriptor,
): PermissionModeGroupId {
    return descriptor.source === 'provider-native' ? 'claude' : 'codexLike';
}

export function resolvePermissionModeGroupForAgent(agentId: AgentId): PermissionModeGroupId {
    return resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor(agentId));
}

export function normalizePermissionModeForAgent(params: { agentId: AgentId; mode: PermissionMode }): PermissionMode {
    return normalizePermissionModeForGroup(params.mode, resolvePermissionModeGroupForAgent(params.agentId));
}

export type ProviderNativePermissionMode = PermissionMode | 'auto' | 'dontAsk';

export function resolveProviderNativePermissionModeForAgent(params: {
    agentId: AgentId;
    mode: PermissionMode;
}): ProviderNativePermissionMode {
    if (resolvePermissionModeGroupForAgent(params.agentId) !== 'claude') {
        return normalizePermissionModeForAgent(params);
    }

    const normalized = normalizePermissionModeForGroup(params.mode, 'claude');
    switch (normalized) {
        case 'yolo':
            return 'bypassPermissions';
        case 'safe-yolo':
            return 'auto';
        case 'read-only':
            return 'dontAsk';
        default:
            return normalized;
    }
}

/**
 * Parse a user-provided permission mode token into a canonical PermissionMode.
 *
 * This accepts common aliases so users can reuse the same vocabulary across providers.
 * The returned value is always a canonical PermissionMode, suitable for persistence.
 */
export function parsePermissionModeAlias(raw: string): PermissionMode | null {
    const normalized = normalizeToken(raw);
    if (!normalized) return null;
    if (isPermissionMode(normalized)) return normalized;

    switch (normalized) {
        // default intent
        case 'ask':
        case 'prompt':
        case 'normal':
            return 'default';

        // claude canonical tokens in case-insensitive form
        case 'acceptedits':
        case 'accept-edits':
            return 'acceptEdits';

        // read-only intent
        case 'readonly':
        case 'read-only':
        case 'read':
        case 'no-tools':
        case 'notools':
        case 'ro':
            return 'read-only';

        // safe-yolo intent (workspace-write with approval; Claude SDK's "auto" mode is the same shape)
        case 'safe':
        case 'safe-yolo':
        case 'safeyolo':
        case 'workspace-write':
        case 'workspace':
        case 'auto-edit':
        case 'auto':
            return 'safe-yolo';

        // yolo intent (full access / bypass prompts)
        case 'yolo':
        case 'full':
        case 'full-access':
        case 'bypass':
        case 'dontask':
        case 'dont-ask':
        case 'danger':
        case 'danger-full-access':
            return 'yolo';

        // claude-specific legacy token that users commonly reuse
        case 'bypasspermissions':
        case 'bypass-permissions':
            return 'bypassPermissions';

        default:
            return null;
    }
}

/**
 * Parse a user-provided token into a provider-agnostic PermissionIntent.
 *
 * This accepts:
 * - canonical intents (default, read-only, safe-yolo, yolo, plan)
 * - common aliases (readonly, ro, full-access, etc.)
 * - legacy provider tokens (acceptEdits, bypassPermissions) as aliases
 *
 * The return value is always an intent suitable for persistence.
 */
export function parsePermissionIntentAlias(raw: string): PermissionIntent | null {
    const parsed = parsePermissionModeAlias(raw);
    if (!parsed) return null;

    switch (parsed) {
        case 'acceptEdits':
            return 'safe-yolo';
        case 'bypassPermissions':
            return 'yolo';
        default:
            return isPermissionIntent(parsed) ? parsed : null;
    }
}

export type PermissionIntentCandidate = Readonly<{
    rawMode: unknown;
    updatedAt: unknown;
}>;

/**
 * Resolve the latest permission intent from a set of timestamped candidates.
 *
 * Intended to keep CLI + UI precedence rules consistent:
 * - candidates whose mode cannot be parsed to a PermissionIntent are ignored
 * - candidates whose updatedAt is not a finite number are ignored
 * - the candidate with the greatest updatedAt wins
 */
export function resolveLatestPermissionIntent(
    candidates: ReadonlyArray<PermissionIntentCandidate>,
): { intent: PermissionIntent; updatedAt: number } | null {
    let best: { intent: PermissionIntent; updatedAt: number } | null = null;

    for (const candidate of candidates) {
        const rawMode = candidate?.rawMode;
        const updatedAtRaw = candidate?.updatedAt;

        const updatedAt =
            typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw)
                ? updatedAtRaw
                : null;
        if (updatedAt === null) continue;

        const modeStr = typeof rawMode === 'string' ? rawMode : null;
        if (!modeStr) continue;

        const intent = parsePermissionIntentAlias(modeStr);
        if (!intent) continue;

        if (!best || updatedAt > best.updatedAt) {
            best = { intent, updatedAt };
        }
    }

    return best;
}
