import { PERMISSION_INTENTS, PERMISSION_MODES, type PermissionIntent, type PermissionMode } from '../types.js';
import type { AgentId } from '../types.js';
import { getAgentSessionModeDescriptor, type AgentSessionModeDescriptor } from '../sessionModes.js';
import {
  parseAgentPermissionIntentV1Alias,
} from '@happier-dev/protocol/runtime';
import {
  parseSessionPermissionModeAlias,
} from '@happier-dev/protocol/sessions/metadata/permission-modes';

export { PERMISSION_MODES };
export type { PermissionIntent, PermissionMode };

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
    const descriptor = getAgentSessionModeDescriptor(agentId);
    // A non-bundled Agent contributes no bundled session-mode descriptor. The generic
    // group is the correct reading of "not provider-native"; it is not a substitution
    // of another Agent's facts.
    return descriptor == null
        ? 'codexLike'
        : resolvePermissionModeGroupForSessionModeDescriptor(descriptor);
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
    return parseAgentPermissionIntentV1Alias(raw);
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
