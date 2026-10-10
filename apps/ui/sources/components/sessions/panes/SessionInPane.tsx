import * as React from 'react';
import { View } from 'react-native';

import { SessionView } from '@/components/sessions/shell/SessionView';
import type { SessionViewEmbeddedPresentation } from '@/components/sessions/shell/embedded/embeddedSessionPresentation';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';

/**
 * One Session, embedded in another surface's pane (ORC §3.8 "Peek", O12; lab `session-D`).
 *
 * It is the real Session renderer — the same transcript and composer the Session's own screen draws,
 * in its embedded presentation — never a second transcript. A reply typed here goes to THIS Session.
 *
 * `active` is the whole lifetime contract: an inactive pane mounts nothing, so it holds no transcript
 * or composer subscription (a peek behind another Details tab, FIN's Settings | Agent tabs). On
 * activation it mounts again and restores from canonical state — the transcript from the store, the
 * draft from the draft owner — rather than from anything this component kept.
 */
export type SessionInPaneProps = Readonly<{
    sessionId: string;
    /** The Session's exact Home, when the host knows it. */
    serverId?: string | null;
    active: boolean;
    /** Whether the pane offers the Session's composer. */
    composer: boolean;
    /** One quiet line under the composer, saying where replies go. */
    repliesBanner?: React.ReactNode;
}>;

export const SessionInPane = React.memo((props: SessionInPaneProps) => {
    // The one embedded arm (plan 05 §4.3.1). A reply typed here goes to this Session, so its model
    // stays choosable; configuration it would not own (agent, profile, voice) stays with the Session.
    const presentation = React.useMemo<SessionViewEmbeddedPresentation>(() => ({
        kind: 'embedded',
        composer: props.composer ? 'auto' : 'none',
        composerControls: 'session',
        modelPicker: true,
        readOnlyNotice: 'openSession',
        repliesBanner: props.repliesBanner,
    }), [props.composer, props.repliesBanner]);
    if (!props.active) {
        return <View testID={`session-in-pane-inactive:${props.sessionId}`} style={{ flex: 1 }} />;
    }
    return <ActiveSessionInPane sessionId={props.sessionId} serverId={props.serverId} presentation={presentation} />;
});

/** Only an opened pane demands exact detail/transcript hydration, through the route's existing owner. */
function ActiveSessionInPane(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    presentation: SessionViewEmbeddedPresentation;
}>) {
    const hydrationOptions = React.useMemo(() => props.serverId ? { serverId: props.serverId } : undefined, [props.serverId]);
    const routeHydrationState = useHydrateSessionForRoute(props.sessionId, 'SessionInPane.hydrate', hydrationOptions);
    return (
        <View testID={`session-in-pane:${props.sessionId}`} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionView
                id={props.sessionId}
                {...(props.serverId ? { routeServerId: props.serverId } : {})}
                routeHydrationState={routeHydrationState}
                surfaceFocusedOverride
                surfaceVisibleOverride
                routeAnchorOverride={false}
                chatBottomSpacing="none"
                presentation={props.presentation}
            />
        </View>
    );
}
