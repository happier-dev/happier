import { PERMISSION_INTENTS, PERMISSION_MODES, type PermissionIntent, type PermissionMode } from '../types.js';
import type { AgentId } from '../types.js';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol';

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isPermissionIntent(value: unknown): value is PermissionIntent {
    return typeof value === 'string' && (PERMISSION_INTENTS as readonly string[]).includes(value);
}

export type PermissionModeGroupId = 'claude' | 'codexLike';
export type ProviderNativePermissionMode = PermissionMode | 'auto' | 'dontAsk';

export function normalizePermissionModeForGroup(mode: PermissionMode, group: PermissionModeGroupId): PermissionMode {
    if (group === 'claude') {
        switch (mode) {
            case 'acceptEdits':
                return 'safe-yolo';
            case 'bypassPermissions':
                return 'yolo';
            case 'plan':
            case 'read-only':
                return 'read-only';
            default:
                return mode;
        }
    }

    switch (mode) {
        case 'acceptEdits':
            return 'safe-yolo';
        case 'bypassPermissions':
            return 'yolo';
        default:
            return mode;
    }
}

export function resolvePermissionModeGroupForAgent(agentId: AgentId): PermissionModeGroupId {
    return agentId === 'claude' ? 'claude' : 'codexLike';
}

export function normalizePermissionModeForAgent(params: { agentId: AgentId; mode: PermissionMode }): PermissionMode {
    return normalizePermissionModeForGroup(params.mode, resolvePermissionModeGroupForAgent(params.agentId));
}

export function resolveProviderNativePermissionModeForAgent(params: {
    agentId: AgentId;
    mode: PermissionMode;
}): ProviderNativePermissionMode {
    const normalized = normalizePermissionModeForAgent(params);
    if (params.agentId !== 'claude') return normalized;

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
    return parseSessionPermissionModeAlias(raw);
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
