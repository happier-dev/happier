import { PERMISSION_INTENTS, PERMISSION_MODES, type PermissionIntent, type PermissionMode } from '../types.js';
import type { AgentId } from '../types.js';
import { getAgentSessionModeDescriptor, type AgentSessionModeDescriptor } from '../sessionModes.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import type { NativePermissionChoicesV1, SessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

export { PERMISSION_MODES };
export { getAgentSessionModesKind } from '../sessionModes.js';
export type { PermissionIntent, PermissionMode };

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isPermissionIntent(value: unknown): value is PermissionIntent {
    return typeof value === 'string' && (PERMISSION_INTENTS as readonly string[]).includes(value);
}

export function normalizePermissionModeForSessionDescriptor(params: {
    mode: PermissionMode;
    descriptor: AgentSessionModeDescriptor | null | undefined;
}): PermissionMode {
    const normalized = parsePermissionIntentAlias(params.mode) ?? 'default';
    // Planning is a restrictive behavior selection only when the Agent declares it.
    return normalized === 'plan' && params.descriptor?.semantics !== 'agent-modes'
        ? 'read-only'
        : normalized;
}

export function normalizePermissionModeForAgent(params: { agentId: AgentId; mode: PermissionMode }): PermissionMode {
    return normalizePermissionModeForSessionDescriptor({
        mode: params.mode,
        descriptor: getAgentSessionModeDescriptor(params.agentId),
    });
}

export type ProviderNativePermissionMode = string;

export function resolveProviderNativePermissionModeForAgent(params: {
    agentId: AgentId;
    mode: PermissionMode;
}): ProviderNativePermissionMode {
    const normalized = normalizePermissionModeForAgent(params);
    // `plan` remains a behavior selection, not permission strictness. Preserve
    // explicit native permission tokens rather than round-tripping through intent aliases.
    const mode = params.mode === 'plan' ? normalized : params.mode;
    const mapping = BUNDLED_AGENT_DEFINITIONS_BY_ID[params.agentId]?.nativePermissionModes;
    return mapping && Object.hasOwn(mapping, mode) ? mapping[mode]! : normalized;
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
export function parsePermissionIntentAlias(raw: unknown): PermissionIntent | null {
    return typeof raw === 'string' ? parseAgentPermissionIntentV1Alias(raw) : null;
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

/** One durable-grant authority decision shared by response admission and pending presentation. */
export function evaluatePermissionResponseAuthorityV1(input: Readonly<{
    response: Readonly<Pick<SessionPermissionRespondRpcParamsV1,
        'execPolicyAmendment' | 'updatedPermissions' | 'allowedTools' | 'mode'> & {
        /** Released CLI response alias. */
        allowTools?: readonly string[];
    }>;
    nativeScope?: NativePermissionChoicesV1['choices'][number]['scope'];
    relationship?: 'owner' | 'sharedApprover' | null;
}>): Readonly<{ allowed: true } | { allowed: false; reason: 'owner_required' }> {
    const durable = input.nativeScope === 'localPersistent'
        || input.response.execPolicyAmendment !== undefined
        || input.response.updatedPermissions !== undefined
        || input.response.allowedTools !== undefined
        || input.response.allowTools !== undefined
        || input.response.mode !== undefined;
    return durable && input.relationship !== 'owner'
        ? { allowed: false, reason: 'owner_required' }
        : { allowed: true };
}
