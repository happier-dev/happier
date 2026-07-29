import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    loadRawAgentInputLocalUiState,
    saveRawAgentInputLocalUiState,
    type RawAgentInputLocalUiStateEntry,
} from '@/sync/domains/state/agentInputLocalUiStatePersistence';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCROLL_TEXT_LENGTH_DRIFT_RATIO = 0.5;

export const AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS = 7;

export type AgentInputDraftOwner =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'newSession'; flowId: string }>;

export type AgentInputLocalUiStateV1 = Readonly<{
    v: 1;
    expanded?: boolean;
    scrollY?: number;
    selection?: Readonly<{ start: number; end: number }>;
    textLength?: number;
    fontScale?: number;
    updatedAt: number;
}>;

export type AgentInputLocalUiStatePatch = Readonly<Omit<Partial<AgentInputLocalUiStateV1>, 'v' | 'updatedAt'>>;

type CacheEntry = {
    values: Record<string, AgentInputLocalUiStateV1>;
    dirty: boolean;
};

const cacheByScopeKey = new Map<string, CacheEntry>();

function scopeCacheKey(scope?: ServerAccountScope | null): string {
    return scope ? `scope:${serverAccountScopeKeySuffix(scope)}` : 'legacy';
}

function areJsonValuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeOwnerId(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function agentInputDraftOwnerKey(owner: AgentInputDraftOwner): string | null {
    if (owner.kind === 'session') {
        const sessionId = normalizeOwnerId(owner.sessionId);
        return sessionId ? `session:${sessionId}` : null;
    }
    const flowId = normalizeOwnerId(owner.flowId);
    return flowId ? `new-session:${flowId}` : null;
}

function normalizePersistedOwnerKey(ownerKey: string): string | null {
    if (ownerKey.startsWith('session:')) {
        const sessionId = normalizeOwnerId(ownerKey.slice('session:'.length));
        return sessionId ? `session:${sessionId}` : null;
    }
    if (ownerKey.startsWith('new-session:')) {
        const flowId = normalizeOwnerId(ownerKey.slice('new-session:'.length));
        return flowId ? `new-session:${flowId}` : null;
    }
    return null;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
}

function finiteInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.trunc(value);
}

function finitePositiveNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

function sanitizeSelection(value: unknown, textLength?: number): AgentInputLocalUiStateV1['selection'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const rawStart = finiteInteger(record.start);
    const rawEnd = finiteInteger(record.end);
    if (rawStart === undefined || rawEnd === undefined) return undefined;
    const max = textLength ?? Math.max(rawStart, rawEnd);
    const start = Math.min(Math.max(rawStart, 0), max);
    const end = Math.min(Math.max(rawEnd, start), max);
    return { start, end };
}

function sanitizeState(value: unknown): AgentInputLocalUiStateV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1) return null;
    const updatedAt = finiteNonNegativeInteger(record.updatedAt);
    if (updatedAt === undefined) return null;

    const textLength = finiteNonNegativeInteger(record.textLength);
    const fontScale = finitePositiveNumber(record.fontScale);
    const selection = sanitizeSelection(record.selection, textLength);
    const scrollY = finiteNonNegativeInteger(record.scrollY);
    const expanded = typeof record.expanded === 'boolean' ? record.expanded : undefined;
    const sanitized: AgentInputLocalUiStateV1 = {
        v: 1,
        ...(expanded !== undefined ? { expanded } : {}),
        ...(scrollY !== undefined ? { scrollY } : {}),
        ...(selection ? { selection } : {}),
        ...(textLength !== undefined ? { textLength } : {}),
        ...(fontScale !== undefined ? { fontScale } : {}),
        updatedAt,
    };
    return Object.keys(sanitized).length > 2 ? sanitized : null;
}

function sanitizeMap(raw: Record<string, RawAgentInputLocalUiStateEntry>): CacheEntry {
    const values: Record<string, AgentInputLocalUiStateV1> = {};
    let dirty = false;
    for (const [rawOwnerKey, rawState] of Object.entries(raw)) {
        const ownerKey = normalizePersistedOwnerKey(rawOwnerKey);
        if (!ownerKey) {
            dirty = true;
            continue;
        }
        const sanitized = sanitizeState(rawState);
        if (!sanitized) {
            dirty = true;
            continue;
        }
        values[ownerKey] = sanitized;
        if (ownerKey !== rawOwnerKey || !areJsonValuesEqual(rawState, sanitized)) {
            dirty = true;
        }
    }
    return { values, dirty };
}

function getCache(scope?: ServerAccountScope | null): CacheEntry {
    const key = scopeCacheKey(scope);
    const existing = cacheByScopeKey.get(key);
    if (existing) return existing;
    const cache = sanitizeMap(loadRawAgentInputLocalUiState(scope));
    cacheByScopeKey.set(key, cache);
    return cache;
}

function shouldDropScrollForContext(
    state: AgentInputLocalUiStateV1,
    context?: Readonly<{ textLength?: number; fontScale?: number }>,
): boolean {
    if (state.scrollY === undefined || !context) return false;
    if (
        state.fontScale !== undefined
        && context.fontScale !== undefined
        && Math.abs(state.fontScale - context.fontScale) > 0.001
    ) {
        return true;
    }
    if (state.textLength !== undefined && context.textLength !== undefined) {
        const denominator = Math.max(1, state.textLength);
        return Math.abs(context.textLength - state.textLength) / denominator > SCROLL_TEXT_LENGTH_DRIFT_RATIO;
    }
    return false;
}

/**
 * Whether the persisted state's text basis matches the live text closely
 * enough for its transient payload (scroll/selection) to be applied. On
 * session open the composer mounts before the draft text is adopted (live
 * textLength 0 vs persisted textLength N), so the payload is withheld or
 * clamped; restore consumers use this predicate to know when the basis has
 * been adopted. Uses the same drift tolerance as the scrollY guard above.
 */
export function isAgentInputLocalUiStateTextBasisApplicable(
    state: AgentInputLocalUiStateV1 | null,
    textLength: number | undefined,
): boolean {
    if (!state) return true;
    if (state.textLength === undefined || textLength === undefined) return true;
    const denominator = Math.max(1, state.textLength);
    return Math.abs(textLength - state.textLength) / denominator <= SCROLL_TEXT_LENGTH_DRIFT_RATIO;
}

export function readAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
    context?: Readonly<{ textLength?: number; fontScale?: number }>,
): AgentInputLocalUiStateV1 | null {
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey) return null;
    const state = getCache(scope).values[ownerKey];
    if (!state) return null;
    const textLength = finiteNonNegativeInteger(context?.textLength);
    const selection = sanitizeSelection(state.selection, textLength ?? state.textLength);
    const nextState = selection
        ? { ...state, selection }
        : (() => {
            const { selection: _selection, ...withoutSelection } = state;
            return withoutSelection;
        })();
    if (!shouldDropScrollForContext(state, context)) return nextState;
    const { scrollY: _scrollY, ...withoutScroll } = nextState;
    return withoutScroll;
}

export function patchAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
    patch: AgentInputLocalUiStatePatch,
    now: number = Date.now(),
): void {
    const cache = getCache(scope);
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey) return;
    const existing = cache.values[ownerKey];
    const candidate = sanitizeState({
        ...(existing ?? {}),
        ...patch,
        v: 1,
        updatedAt: existing?.updatedAt ?? now,
    });
    if (!candidate) return;
    if (existing && areJsonValuesEqual(existing, candidate)) return;
    const next = sanitizeState({
        ...(existing ?? {}),
        ...patch,
        v: 1,
        updatedAt: Number.isFinite(now) && now >= 0 ? Math.trunc(now) : Date.now(),
    });
    if (!next) return;
    if (existing && areJsonValuesEqual(existing, next)) return;
    cache.values[ownerKey] = next;
    cache.dirty = true;
}

export function clearAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
): void {
    const cache = getCache(scope);
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey || !cache.values[ownerKey]) return;
    delete cache.values[ownerKey];
    cache.dirty = true;
}

export function clearAgentInputLocalUiStateForSession(scope: ServerAccountScope | null | undefined, sessionId: string): void {
    clearAgentInputLocalUiState(scope, { kind: 'session', sessionId });
}

export function clearAgentInputLocalUiStateForNewSession(scope: ServerAccountScope | null | undefined, flowId: string): void {
    clearAgentInputLocalUiState(scope, { kind: 'newSession', flowId });
}

export function garbageCollectAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    options: Readonly<{ now: number }>,
): void {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cache = getCache(scope);
    for (const [ownerKey, state] of Object.entries(cache.values)) {
        if (now - state.updatedAt > AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS * DAY_MS) {
            delete cache.values[ownerKey];
            cache.dirty = true;
        }
    }
}

export function flushAgentInputLocalUiState(scope?: ServerAccountScope | null): void {
    const cache = getCache(scope);
    if (!cache.dirty) return;
    saveRawAgentInputLocalUiState(cache.values, scope);
    cache.dirty = false;
}

export function invalidateAgentInputLocalUiStateCache(scope?: ServerAccountScope | null): void {
    cacheByScopeKey.delete(scopeCacheKey(scope));
}

export function resetAgentInputLocalUiStateCachesForTests(): void {
    cacheByScopeKey.clear();
}
