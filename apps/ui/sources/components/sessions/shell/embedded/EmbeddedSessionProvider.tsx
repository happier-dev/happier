import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { requestRegisteredSessionComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import type { SessionViewEmbeddedPresentation } from './embeddedSessionPresentation';
import { EmbeddedSessionNewChat } from './EmbeddedSessionNewChat';
import type { EmbeddedSessionTarget } from './embeddedSessionTarget';
import { EmbeddedSessionStablePartsScope } from './EmbeddedSessionPartSlots';
import { EmbeddedSessionArrangementPartsProvider, EmbeddedSessionControllerClaimsScope, EmbeddedSessionStandardLayout } from './EmbeddedSessionParts';

export type { SessionViewEmbeddedPresentation } from './embeddedSessionPresentation';
export type {
    EmbeddedNewSessionCreated,
    EmbeddedNewSessionDraft,
    EmbeddedSessionNewChatCreation,
    EmbeddedSessionNewChatTarget,
    EmbeddedSessionTarget,
} from './embeddedSessionTarget';
export {
    EmbeddedSessionComposerPart,
    EmbeddedSessionStandardLayout,
    EmbeddedSessionTranscriptPart,
} from './EmbeddedSessionParts';

const FILL_STYLE = Object.freeze({ flex: 1, minHeight: 0, minWidth: 0 });

export type EmbeddedSessionProviderProps = Readonly<{
    target: EmbeddedSessionTarget;
    /** The Session's exact Home. The mounting host resolves it; nothing else is trusted. */
    serverId: string | null;
    presentation: SessionViewEmbeddedPresentation;
    /** Whether the mount is the viewer's focus (read cursor, composer focus eligibility). */
    surfaceFocused: boolean;
    /** Whether the mount is visible to the viewer now (composer command targeting). */
    surfaceVisible: boolean;
    /** The arrangement of session parts; defaults to the standard layout. */
    children?: React.ReactNode;
    testID?: string;
}>;

/**
 * The one controller of an embedded Session (plan 05 §4.3.4).
 *
 * It hydrates the Session and mounts the incumbent `SessionView` in its embedded presentation; the
 * parts (`EmbeddedSessionTranscriptPart`, `EmbeddedSessionComposerPart`, or
 * `EmbeddedSessionStandardLayout`) are slots of that one controller wherever they sit in
 * `children`. It navigates nothing and writes no route or pane state of its own.
 */
export function EmbeddedSessionProvider(props: EmbeddedSessionProviderProps) {
    const [createdSessionId, setCreatedSessionId] = React.useState<string | null>(null);
    const reducedMotion = useReducedMotionPreference();
    const target = props.target;
    // A new chat continues on the Session its first Send created, under this same root: the parts
    // and anything the host bound to this provider stay mounted.
    const sessionId = target.kind === 'session' ? target.sessionId : createdSessionId;
    const handoffEntering = React.useMemo(() => createdSessionId === sessionId && createdSessionId !== null && !reducedMotion
        ? FadeIn.duration(reanimatedMotionTokens.durationMs.base)
        : undefined, [createdSessionId, reducedMotion, sessionId]);
    const serverIdRef = React.useRef(props.serverId);
    serverIdRef.current = props.serverId;
    const handleCreated = React.useCallback((created: string) => {
        setCreatedSessionId(created);
        // Focus stays in the composer: the created Session's composer takes it as it registers.
        const serverId = serverIdRef.current?.trim();
        if (serverId) requestRegisteredSessionComposerFocus({ serverId, sessionId: created });
    }, []);
    React.useEffect(() => {
        if (target.kind === 'session') setCreatedSessionId(null);
    }, [target.kind]);

    const producer = sessionId ? (
                <Animated.View
                    key={sessionId}
                    // A new chat hands over to its Session with a short fade (the session composer takes
                    // the new-session composer's place); reduced motion makes it instant.
                    entering={handoffEntering}
                    style={FILL_STYLE}
                >
                <EmbeddedSessionForId
                    sessionId={sessionId}
                    serverId={props.serverId}
                    presentation={props.presentation}
                    surfaceFocused={props.surfaceFocused}
                    surfaceVisible={props.surfaceVisible}
                >
                    {props.children}
                </EmbeddedSessionForId>
                </Animated.View>
            ) : target.kind === 'new' ? (
                <EmbeddedSessionNewChat
                    target={target}
                    serverId={props.serverId}
                    arrangement={props.children}
                    onCreated={handleCreated}
                />
            ) : null;
    const usesStableWebSlots = Platform.OS === 'web' && typeof document !== 'undefined';
    return (
        <View testID={props.testID ?? 'embedded-session'} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedSessionControllerClaimsScope>
                <EmbeddedSessionStablePartsScope readyEntering={handoffEntering} renderArrangement={(parts) => (
                    <EmbeddedSessionArrangementPartsProvider value={parts}>
                        {props.children ?? <EmbeddedSessionStandardLayout />}
                    </EmbeddedSessionArrangementPartsProvider>
                )}>
                    {usesStableWebSlots ? (
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0 }}>
                            {producer}
                        </View>
                    ) : producer}
                </EmbeddedSessionStablePartsScope>
            </EmbeddedSessionControllerClaimsScope>
        </View>
    );
}

function EmbeddedSessionForId(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    presentation: SessionViewEmbeddedPresentation;
    surfaceFocused: boolean;
    surfaceVisible: boolean;
    children?: React.ReactNode;
}>) {
    const serverId = props.serverId?.trim() || undefined;
    const routeHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'EmbeddedSessionProvider.ensureSessionVisible',
        serverId ? { serverId } : undefined,
    );
    const displayNameSource = useSessionDisplayNameSource(props.sessionId, serverId);
    const accessibilityLabel = displayNameSource
        ? t('session.embedded.regionLabel', { title: getSessionName(displayNameSource, serverId) })
        : undefined;
    return (
        <View accessibilityLabel={accessibilityLabel} style={FILL_STYLE}>
        <SessionView
            id={props.sessionId}
            {...(serverId ? { routeServerId: serverId } : {})}
            routeHydrationState={routeHydrationState}
            surfaceFocusedOverride={props.surfaceFocused}
            surfaceVisibleOverride={props.surfaceVisible}
            routeAnchorOverride={false}
            safeAreaTopMode="external"
            headerSafeAreaTopMode="external"
            chatBottomSpacing="none"
            presentation={props.presentation}
            embeddedArrangement={props.children}
        />
        </View>
    );
}
