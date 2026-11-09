import * as React from 'react';
import type { View } from 'react-native';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import {
    readSessionComposerActionChipOffer,
    requestRegisteredSessionComposerActionChip,
    subscribeSessionComposerPresentationTargets,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useDeviceType } from '@/utils/platform/responsive';

import { SESSION_GOAL_CHIP_KEY } from './sessionGoalChipKey';

/**
 * The Goal control's one external open entry (FIN 04 §5.5, X5).
 *
 * The Goal control is the session composer's goal chip and its popover; there is no second Goal
 * control. Any other surface — the Work tab's "+" › Keep going until done…, its Goal row — opens that
 * same popover by asking the exact Home/Session composer through the presentation-target registry. The
 * request waits for that composer when it is not on screen yet.
 */

/** Opens the Goal control of the exact session composer, or retains the request until it can. */
export function openSessionGoalControl(address: SessionAddress, anchorRef?: React.RefObject<View | null>): boolean {
    return requestRegisteredSessionComposerActionChip(address, SESSION_GOAL_CHIP_KEY, anchorRef);
}

export type SessionGoalControlEntry = Readonly<{
    /**
     * The session's composer offers the Goal control (it can hold a goal and this person may edit it). On a
     * phone the Work page has no composer mounted beside it to ask, so the entry stays offered and the
     * request waits for the Chat surface it opens (see `open`).
     */
    available: boolean;
    /** Beside the composer, a row passes its own view so the popover opens where it was pressed. */
    open: (anchorRef?: React.RefObject<View | null>) => void;
}>;

/**
 * The entry for surfaces beside or above a session. Beside the session the composer is on screen and
 * the popover opens in place; on a phone the composer is the session's Chat surface, which is shown
 * first so the request lands on it.
 */
export function useSessionGoalControlEntry(params: Readonly<{
    sessionId: string;
    serverId: string | null | undefined;
}>): SessionGoalControlEntry {
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const cockpitNavigation = useSessionCockpitSurfaceNavigation();
    const { sessionId } = params;
    const serverId = params.serverId?.trim() || null;
    const readOffer = React.useCallback(
        () => (serverId ? readSessionComposerActionChipOffer({ serverId, sessionId }, SESSION_GOAL_CHIP_KEY) : 'no_composer' as const),
        [serverId, sessionId],
    );
    const offer = React.useSyncExternalStore(subscribeSessionComposerPresentationTargets, readOffer, readOffer);
    const available = offer === 'offered' || (offer === 'no_composer' && phone && serverId !== null);

    const open = React.useCallback((anchorRef?: React.RefObject<View | null>) => {
        if (!serverId) return;
        // On a phone the composer is the Chat surface: there is no row beside it to hang from.
        const opened = openSessionGoalControl({ serverId, sessionId }, phone ? undefined : anchorRef);
        if (opened || !phone) return;
        if (cockpitNavigation) {
            cockpitNavigation.switchSurface('chat');
            return;
        }
        router.push(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId }) as Href);
    }, [cockpitNavigation, phone, router, serverId, sessionId]);

    return React.useMemo(() => ({ available, open }), [available, open]);
}
