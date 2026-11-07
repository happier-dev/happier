import * as React from 'react';
import type { NewSessionDraftEntryMode } from '@happier-dev/protocol/account/settings/accountSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import type { KeyboardPlatform } from '@/keyboard/types';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useOrdinaryNewSessionDraftId } from '@/sync/domains/state/newSessionTargetUiState';
import { getSessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { resolveNewSessionDraftRouteIdentity } from './newSessionDraftRouteIdentity';

export type NewSessionOrdinaryEntryRouteResolution = Readonly<{
    draftId: string;
    draftOrigin: 'ordinary';
    resumedPrevious: boolean;
}>;

export function resolveNewSessionOrdinaryEntryRoute(params: Readonly<{
    entryMode: NewSessionDraftEntryMode;
    forceFresh: boolean;
    ordinaryEntryDraftId: string | null;
    ordinaryEntryDraftIsMeaningful: boolean;
    createDraftId?: () => string;
}>): NewSessionOrdinaryEntryRouteResolution {
    if (
        !params.forceFresh
        && params.entryMode === 'resumePrevious'
        && params.ordinaryEntryDraftIsMeaningful
        && params.ordinaryEntryDraftId
    ) {
        const resumed = resolveNewSessionDraftRouteIdentity({
            routeDraftId: params.ordinaryEntryDraftId,
            createDraftId: params.createDraftId,
        });
        if (!resumed.shouldWriteRouteParam) {
            return {
                draftId: resumed.draftId,
                draftOrigin: 'ordinary',
                resumedPrevious: true,
            };
        }
    }

    return {
        draftId: resolveNewSessionDraftRouteIdentity({
            routeDraftId: undefined,
            createDraftId: params.createDraftId,
        }).draftId,
        draftOrigin: 'ordinary',
        resumedPrevious: false,
    };
}

export function shouldForceFreshNewSessionEntry(params: Readonly<{
    platform: KeyboardPlatform;
    metaKey: boolean;
    ctrlKey: boolean;
}>): boolean {
    return params.platform === 'macos' ? params.metaKey : params.ctrlKey;
}

export function shouldForceFreshNewSessionEntryFromPressEvent(
    event?: unknown,
    platform: KeyboardPlatform = resolveKeyboardPlatform(),
): boolean {
    const eventRecord = event && typeof event === 'object'
        ? event as Readonly<Record<string, unknown>>
        : null;
    const nativeEvent = eventRecord?.nativeEvent && typeof eventRecord.nativeEvent === 'object'
        ? eventRecord.nativeEvent as Readonly<Record<string, unknown>>
        : null;
    return shouldForceFreshNewSessionEntry({
        platform,
        metaKey: eventRecord?.metaKey === true || nativeEvent?.metaKey === true,
        ctrlKey: eventRecord?.ctrlKey === true || nativeEvent?.ctrlKey === true,
    });
}

/**
 * Resolving an entry only picks a draft identity; it writes nothing. A fresh ordinary draft stays local
 * entry context until the person authors in it (its active Space is applied by the placement owner,
 * `useNewSessionOrganizationPlacement`), so opening New Session never leaves a draft on the Account.
 */
export function useResolveNewSessionOrdinaryEntryRoute(scopeOverride?: ServerAccountScope | null): (
    options?: Readonly<{ forceFresh?: boolean; createDraftId?: () => string }>,
) => NewSessionOrdinaryEntryRouteResolution {
    const entryMode = useSetting('newSessionDraftEntryMode');
    const activeScope = useActiveServerAccountScope();
    const scope = scopeOverride === undefined ? activeScope : scopeOverride;
    const ordinaryEntryDraftId = useOrdinaryNewSessionDraftId(scope);

    return React.useCallback((options = {}) => {
        const rememberedDraftId = ordinaryEntryDraftId;
        const snapshot = scope && rememberedDraftId
            ? getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: rememberedDraftId })
            : null;
        return resolveNewSessionOrdinaryEntryRoute({
            entryMode,
            forceFresh: options.forceFresh === true,
            ordinaryEntryDraftId: rememberedDraftId,
            ordinaryEntryDraftIsMeaningful: snapshot?.materialized === true,
            createDraftId: options.createDraftId,
        });
    }, [entryMode, ordinaryEntryDraftId, scope]);
}
