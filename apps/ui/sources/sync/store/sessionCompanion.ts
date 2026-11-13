import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { buildRealmQualifiedSessionCompanionPreferenceKey } from '@/components/sessions/companion/state/sessionCompanionPreferenceKey';
import { HIDDEN_SESSION_COMPANION_PREFERENCE_V1 } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from '../domains/state/persistentUiState';
import { getStorage } from '../domains/state/storageStore';
import type { LocalSettings } from '../domains/settings/localSettings';
import { resolveSessionLocalPreferenceRealm } from '../domains/settings/sessionLocalPreferenceKey';
import { normalizeSessionId } from '../domains/session/normalizeSessionId';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';
import { resolveSessionListLookupSessionServerScopeFromState } from '../domains/session/listing/sessionListLookupState';
import type { StorageState } from './types';

export type SessionCompanionPreferenceEntry = AuthoredPreference & Interaction;
type AuthoredPreference = LocalSettings['sessionCompanionPreferencesBySessionV1'][string];
export type SessionCompanionPreferenceSlot = Readonly<{
    /** null when the current Account/Home cannot prove this Session's realm. */
    storageKey: string | null;
    /** Authored preference with device interaction state overlaid; unreadable versions stay intact. */
    stored: SessionCompanionPreferenceEntry | undefined;
}>;
type CompanionState = Pick<StorageState, 'profileScope' | 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId' | 'concurrentSessionListCacheByServerId' | 'localSettings'>;
type Interaction = Readonly<{ visible: boolean; collapsed: boolean }>;

const interactionState = createPersistentUiState<Interaction>('session-companion-interaction-v1', value => {
    if (!value || typeof value !== 'object' || !('visible' in value) || typeof value.visible !== 'boolean'
        || !('collapsed' in value) || typeof value.collapsed !== 'boolean') {
        return { visible: false, collapsed: false };
    }
    return { visible: value.visible, collapsed: value.collapsed };
});

function writeInteraction(key: string, value: Interaction): void {
    try { interactionState.set(key, value); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[companion] Device interaction state could not be persisted.');
    }
}

function overlayInteraction(stored: AuthoredPreference | undefined, interaction: Interaction | undefined): SessionCompanionPreferenceEntry | undefined {
    if (!stored && !interaction) return undefined;
    return { ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, ...stored, items: stored?.items ?? [], visible: interaction?.visible ?? false, collapsed: interaction?.collapsed ?? false };
}

function readRawSlot(state: CompanionState, sessionId: string | null, activeServerId: string | null | undefined, explicitServerId?: string | null): Readonly<{ storageKey: string | null; stored: AuthoredPreference | undefined }> {
    const normalizedSessionId = sessionId ? normalizeSessionId(sessionId) : null;
    if (!normalizedSessionId) return { storageKey: null, stored: undefined };
    const resolvedServerId = normalizeTrimmedString(explicitServerId)
        || (resolveSessionListLookupSessionServerScopeFromState({
            sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        }, normalizedSessionId)?.serverId ?? null);
    const realm = resolveSessionLocalPreferenceRealm({ activeScope: state.profileScope, activeServerId, targetServerId: resolvedServerId });
    const storageKey = realm ? buildRealmQualifiedSessionCompanionPreferenceKey(realm, normalizedSessionId) : null;
    return { storageKey, stored: storageKey ? state.localSettings.sessionCompanionPreferencesBySessionV1?.[storageKey] : undefined };
}

/** Hooks and admitted Actions share the same realm-qualified state owner. */
export function readSessionCompanionPreferenceSlotFromState(state: CompanionState, sessionId: string | null, activeServerId: string | null | undefined, serverId?: string | null): SessionCompanionPreferenceSlot {
    const slot = readRawSlot(state, sessionId, activeServerId, serverId);
    return { ...slot, stored: overlayInteraction(slot.stored, slot.storageKey ? interactionState.read(slot.storageKey) : undefined) };
}

export function useSessionCompanionPreferenceSlot(sessionId: string | null, serverId?: string | null): SessionCompanionPreferenceSlot {
    const activeServer = useActiveServerSnapshot();
    // Keep selector snapshots stable; compose the separately keyed interaction subscription afterward.
    const slot = getStorage()(useShallow(state => readRawSlot(state, sessionId, activeServer.serverId, serverId)));
    const interaction = usePersistentUiStateValue(interactionState, slot.storageKey);
    return React.useMemo(() => ({ ...slot, stored: overlayInteraction(slot.stored, interaction) }), [slot, interaction]);
}

/** The updater consumes current composed state, preserving stale-closure and inverse semantics. */
export function useMutateSessionCompanionPreference(): (
    sessionId: string,
    updater: (stored: SessionCompanionPreferenceEntry | undefined) => SessionCompanionPreferenceEntry | null,
    serverId?: string | null,
) => boolean {
    const activeServer = useActiveServerSnapshot();
    return React.useCallback((sessionId, updater, serverId) => {
        const state = getStorage().getState();
        const slot = readRawSlot(state, sessionId, activeServer.serverId, serverId);
        if (!slot.storageKey) return false;
        const next = updater(overlayInteraction(slot.stored, interactionState.read(slot.storageKey)));
        if (next === null) return false;
        const { visible, collapsed, ...authored } = next;
        if (!sameStrictJsonValue(slot.stored ?? { v: 1, edge: 'trailing', density: 'compact', items: [] }, authored)) {
            state.applyLocalSettings({ sessionCompanionPreferencesBySessionV1: {
                ...state.localSettings.sessionCompanionPreferencesBySessionV1,
                [slot.storageKey]: authored,
            } }, { source: 'ui' });
        }
        writeInteraction(slot.storageKey, { visible, collapsed });
        return true;
    }, [activeServer.serverId]);
}
