import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import {
    EmbeddedSessionProvider,
    EmbeddedSessionStandardLayout,
    type EmbeddedNewSessionDraft,
    type EmbeddedSessionTarget,
    type SessionViewEmbeddedPresentation,
} from '@/components/sessions/shell/embedded/EmbeddedSessionProvider';
import { clearSessionSurfaceVisibilityForNonSessionRoute } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useEmbedSessionRuntime } from '@/embed/runtime/EmbedSessionRuntimeProvider';
import { EmbedRuntimeStateSurface } from '@/embed/state/EmbedRuntimeStateSurface';
import { buildEmbedSessionPresentation } from '@/embed/embedSessionPresentation';

function readSurfaceFacts() {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    return { visible, focused: visible && (typeof document === 'undefined' || document.hasFocus()) };
}

function useEmbedSurfaceFacts() {
    const [facts, setFacts] = React.useState(readSurfaceFacts);
    React.useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return;
        const update = () => {
            const next = readSurfaceFacts();
            setFacts((current) => current.visible === next.visible && current.focused === next.focused ? current : next);
        };
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);
        document.addEventListener('visibilitychange', update);
        update();
        return () => {
            window.removeEventListener('focus', update);
            window.removeEventListener('blur', update);
            document.removeEventListener('visibilitychange', update);
        };
    }, []);
    return facts;
}

/** One presentation over the admitted scope; hydration remains owned by O05's provider. */
export function EmbedSessionViewport() {
    const { runtime, snapshot } = useEmbedSessionRuntime();
    const { theme } = useUnistyles();
    const pathname = usePathname();
    const facts = useEmbedSurfaceFacts();
    React.useEffect(() => { clearSessionSurfaceVisibilityForNonSessionRoute(pathname); }, [pathname]);
    const onCreate = React.useCallback((draft: EmbeddedNewSessionDraft, attempt: Readonly<{ attemptId: string }>) => (
        runtime.createSession(draft, attempt)
    ), [runtime]);
    const onPresented = React.useCallback((sessionId: string) => {
        runtime.presentCreatedSession(sessionId);
    }, [runtime]);
    const retry = React.useCallback(() => { void runtime.retry(); }, [runtime]);
    const target = React.useMemo<EmbeddedSessionTarget | null>(() => {
        if (!snapshot.credential || !snapshot.self) return null;
        if (snapshot.presentationTargetKind === 'new') {
            return snapshot.creationConfig
                ? { kind: 'new', creation: snapshot.creationConfig, onCreate, onPresented }
                : null;
        }
        return snapshot.displayedSessionId && snapshot.displayedSessionId === snapshot.requestedSessionId
            ? { kind: 'session', sessionId: snapshot.displayedSessionId }
            : null;
    }, [snapshot.credential, snapshot.self, snapshot.presentationTargetKind, snapshot.creationConfig,
        snapshot.displayedSessionId, snapshot.requestedSessionId, onCreate, onPresented]);
    const presentation = React.useMemo<SessionViewEmbeddedPresentation>(
        () => buildEmbedSessionPresentation({ phase: snapshot.phase, self: snapshot.self, ui: snapshot.ui, reconnecting: snapshot.reconnecting }),
        [snapshot.phase, snapshot.self, snapshot.ui, snapshot.reconnecting],
    );

    // Preview supplies its read-only transcript in the nested route and never admits a credential.
    if (pathname === '/embed/preview') return null;

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.background.canvas }}>
            {!target || snapshot.phase !== 'ready' ? (
                <EmbedRuntimeStateSurface phase={snapshot.phase} error={snapshot.error} onRetry={retry} retained={target !== null} />
            ) : null}
            {target ? (
                <EmbeddedSessionProvider
                    key={snapshot.presentationTargetKey}
                    target={target}
                    serverId={runtime.endpointUrl}
                    presentation={presentation}
                    surfaceFocused={facts.focused}
                    surfaceVisible={facts.visible}
                >
                    <EmbeddedSessionStandardLayout />
                </EmbeddedSessionProvider>
            ) : null}
        </View>
    );
}
