import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { resolveEffectiveAttentionDeliveryPolicy } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { projectSessionFollowerCensus } from '@/components/sessions/collaboration/SessionPeopleFollowSections';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { useSessionListRenderableWithServerScope } from '@/sync/store/hooks';
import { readExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

import { AccountSessionFollowEditor, type AccountSessionFollowEditorParts } from './AccountSessionFollowEditor';
import { FollowSessionMark } from './FollowSessionMark';
import { useAccountSessionFollowController } from './useAccountSessionFollowController';
import { useAccountVoiceFollowReadiness } from './useAccountVoiceFollowReadiness';
import { useSessionFollowers } from './useSessionFollowers';
import { useSessionInProgressTurnId } from './useSessionInProgressTurnId';

/** The quiet-hours window in effect on this device ("22:00–07:00"), `on` for several, null when off. */
function useQuietHoursSummary(): string | null {
    const accountPolicy = useSetting('attentionDeliveryPolicyV1');
    const deviceOverrides = useLocalSetting('attentionDeviceOverridesV1');
    return React.useMemo(() => {
        const { quietHours } = resolveEffectiveAttentionDeliveryPolicy({
            accountSettings: { attentionDeliveryPolicyV1: accountPolicy },
            localSettings: { attentionDeviceOverridesV1: deviceOverrides },
        });
        if (quietHours.enabled !== true || quietHours.windows.length === 0) return null;
        const only = quietHours.windows.length === 1 ? quietHours.windows[0] : undefined;
        return only && !only.days?.length ? `${only.startLocalTime}–${only.endLocalTime}` : 'on';
    }, [accountPolicy, deviceOverrides]);
}

export function AccountSessionFollowControl(props: Readonly<{
    address: SessionAddress;
    archived?: boolean;
    onClose?: () => void;
    onOpenNotificationSettings?: () => void;
    /** Places the editor's header, body and footer (the popover panel or the page). */
    frame?: (parts: AccountSessionFollowEditorParts) => React.ReactNode;
}>) {
    const router = useRouter();
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.address.serverId });
    const { serverId, sessionId } = props.address;
    const { controller, state } = useAccountSessionFollowController(props.address, enabled, props.onClose);
    const voiceReadiness = useAccountVoiceFollowReadiness({
        sessionId,
        serverId,
        initialSnapshotPending: state.voiceInitialSnapshotPending,
    });
    // 09C §11.7: Background sync is the external source's acquisition, never a
    // Follow notification switch. When it is off, Happier can only observe that
    // Session while it is attached, and Follow must say so rather than promise
    // delivery it cannot make. The linked-external fact and the policy come from
    // their existing metadata readers; nothing is decided a second time here.
    // Exact Home: the bare-id entity is whichever Home hydrated that id last, so on a
    // Session that exists on two Homes it could describe the other one's link.
    const session = useSessionListRenderableWithServerScope(serverId, sessionId);
    const metadata = session?.metadata ?? null;
    const sourceTurnId = useSessionInProgressTurnId(props.address);
    const notifyOnce = React.useMemo(() => ({ sourceTurnId, onOnce: controller.setOnce }), [controller, sourceTurnId]);
    const externalBackgroundSyncOff = React.useMemo(() => (
        readExternalSessionLink(metadata) !== null
        && readExternalSessionFollowPolicy(metadata) === 'attached_only'
    ), [metadata]);
    // Who else follows it: the same authoritative reverse read and census People draws, you excluded.
    const followers = useSessionFollowers(props.address, enabled);
    const census = React.useMemo(() => projectSessionFollowerCensus(followers.projection), [followers.projection]);
    const alsoFollowing = census.sessions && census.otherPeople !== null
        ? { people: census.otherPeople, sessions: census.sessions.length } : null;
    const quietHours = useQuietHoursSummary();

    if (!enabled) return null;
    return <AccountSessionFollowEditor
        state={state}
        onEditPolicy={(edit) => { void controller.editPolicy(edit); }}
        voiceReadiness={voiceReadiness}
        archived={props.archived === true}
        externalBackgroundSyncOff={externalBackgroundSyncOff}
        notifyOnce={notifyOnce}
        onSet={(preferences) => { void controller.set(preferences); }}
        onRemove={() => { void controller.remove(); }}
        onRetry={() => { void controller.retry(); }}
        onOpenNotificationSettings={() => { props.onOpenNotificationSettings?.(); }}
        sessionMark={<FollowSessionMark session={session} serverId={serverId} />}
        onClose={props.onClose}
        alsoFollowing={alsoFollowing}
        onOpenPeople={() => {
            props.onClose?.();
            router.push(buildScopedSessionRouteHref({ ...props.address,
                query: serializeSessionPaneUrlState({ rightTabId: 'collaboration' }),
            }) as Href);
        }}
        quietHours={quietHours}
        frame={props.frame}
    />;
}
