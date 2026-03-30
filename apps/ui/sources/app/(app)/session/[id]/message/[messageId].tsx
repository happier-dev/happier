import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { View, ActivityIndicator } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useMessage, useResolvedSessionMessageRouteId, useSession, useSessionTranscriptIds } from "@/sync/domains/state/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/ui/forms/Deferred";
import { ToolHeader } from '@/components/tools/shell/presentation/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/shell/presentation/ToolStatusIndicator';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    createSessionMessageDetailsStyles,
    SessionMessageDetailsView,
} from '@/components/sessions/transcript/details/SessionMessageDetailsView';

type SessionMessageRouteTheme = Readonly<{
    colors: Readonly<{
        text: string;
    }>;
}>;

type SessionMessageRouteStyles = Readonly<{
    loadingContainer: ViewStyle;
}> & ReturnType<typeof createSessionMessageDetailsStyles>;

export const createSessionMessageRouteStyles = (theme: SessionMessageRouteTheme): SessionMessageRouteStyles => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    ...createSessionMessageDetailsStyles(theme),
});

type MessageRouteParams = Readonly<{
    id?: string | string[];
    messageId?: string | string[];
    jumpChildId?: string | string[];
}>;

const MESSAGE_ROUTE_BACKFILL_MAX_PROGRESS_PAGES = 25;
const MESSAGE_ROUTE_BACKFILL_WAIT_FOR_PAGINATION_MS = 5000;
const MESSAGE_ROUTE_BACKFILL_RETRY_DELAY_MS = 100;

function normalizeRouteParam(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        const first = value[0];
        if (typeof first === 'string') return first.trim();
    }
    return '';
}

export default React.memo(function SessionMessageRoute() {
    const params = useLocalSearchParams<MessageRouteParams>();
    const sessionId = normalizeRouteParam(params.id);
    const messageId = normalizeRouteParam(params.messageId);
    const jumpChildId = normalizeRouteParam(params.jumpChildId) || null;

    if (!sessionId || !messageId) {
        return <SessionInvalidLinkFallback />;
    }

    return <SessionMessageRouteLoaded sessionId={sessionId} messageId={messageId} jumpChildId={jumpChildId} />;
});

function SessionMessageRouteLoaded(props: { sessionId: string; messageId: string; jumpChildId: string | null }) {
    const router = useRouter();
    const session = useSession(props.sessionId);
    const { isLoaded: messagesLoaded } = useSessionTranscriptIds(props.sessionId);
    const resolvedMessageId = useResolvedSessionMessageRouteId(props.sessionId, props.messageId);
    const resolvedJumpChildId = useResolvedSessionMessageRouteId(props.sessionId, props.jumpChildId ?? '');
    const jumpChildId = props.jumpChildId ? (resolvedJumpChildId ?? props.jumpChildId) : null;
    const message = useMessage(props.sessionId, resolvedMessageId ?? props.messageId);
    const { theme } = useUnistyles();
    const styles = React.useMemo(() => createSessionMessageRouteStyles(theme), [theme]);
    const [messageBackfillComplete, setMessageBackfillComplete] = React.useState(false);

    const tool = message?.kind === 'tool-call' ? message.tool : null;
    const toolHeaderTitle = React.useCallback(() => {
        return tool ? <ToolHeader tool={tool} /> : null;
    }, [tool]);
    const toolHeaderRight = React.useCallback(() => {
        return tool ? <ToolStatusIndicator tool={tool} /> : null;
    }, [tool]);

    const toolScreenOptions = React.useMemo(() => {
        return {
            headerTitle: toolHeaderTitle,
            headerRight: toolHeaderRight,
            headerStyle: {
                backgroundColor: theme.colors.header.background,
            },
            headerTintColor: theme.colors.header.tint,
            headerShadowVisible: false,
        } as const;
    }, [theme.colors.header.background, theme.colors.header.tint, toolHeaderRight, toolHeaderTitle]);

    // Trigger session visibility when component mounts
    React.useEffect(() => {
        sync.onSessionVisible(props.sessionId);
    }, [props.sessionId]);

    React.useEffect(() => {
        setMessageBackfillComplete(false);
    }, [props.messageId, props.sessionId]);

    // Best-effort hydration for deep links / hard refreshes: sessions list is paginated, and message fetch
    // is guarded when a session isn't known on the active server snapshot yet.
    useHydrateSessionForRoute(props.sessionId, 'MessageRoute.ensureSessionVisible');

    // Message deep links may target messages older than the initial `/messages` page. If we can't find
    // the message after the initial load, try paging older messages until we either find it or run out.
    React.useEffect(() => {
        let canceled = false;
        if (!messagesLoaded || message || messageBackfillComplete) return;

        fireAndForget((async () => {
            try {
                try {
                    await sync.ensureSessionVisibleForMessageRoute(props.sessionId);
                } catch {
                    // best-effort only
                }
                const startedAtMs = Date.now();
                let progressedPages = 0;
                while (progressedPages < MESSAGE_ROUTE_BACKFILL_MAX_PROGRESS_PAGES) {
                    const result = await sync.loadOlderMessages(props.sessionId);
                    if (canceled) return;

                    if (result.status === 'not_ready' || result.status === 'in_flight') {
                        if (Date.now() - startedAtMs >= MESSAGE_ROUTE_BACKFILL_WAIT_FOR_PAGINATION_MS) {
                            break;
                        }
                        await new Promise((r) => setTimeout(r, MESSAGE_ROUTE_BACKFILL_RETRY_DELAY_MS));
                        continue;
                    }

                    progressedPages += 1;

                    if (result.status === 'no_more' || result.hasMore === false) {
                        break;
                    }

                    if (result.loaded <= 0) {
                        // Avoid tight loops if the paging cursor doesn't advance.
                        break;
                    }
                }
            } finally {
                if (!canceled) {
                    setMessageBackfillComplete(true);
                }
            }
        })(), { tag: 'MessageRoute.loadOlderMessages' });

        return () => {
            canceled = true;
        };
    }, [message, messageBackfillComplete, messagesLoaded, props.messageId, props.sessionId, resolvedMessageId]);

    React.useEffect(() => {
        if (messageBackfillComplete && messagesLoaded && !message) {
            const canGoBack = typeof (router as any)?.canGoBack === 'function' ? (router as any).canGoBack() : false;
            if (canGoBack) {
                router.back();
                return;
            }
            router.replace(`/session/${encodeURIComponent(props.sessionId)}`);
            return;
        }
    }, [messageBackfillComplete, messagesLoaded, message, props.sessionId, router]);
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    // Show loader while waiting for session and messages to load
    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    // If messages are loaded but specific message not found, show loader briefly
    // The useEffect above will navigate back
    if (!message) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    return (
        <>
            {tool && (
                <Stack.Screen
                    options={toolScreenOptions}
                />
            )}
            <View style={styles.routeContent}>
                <Deferred>
                    <SessionMessageDetailsView
                        message={message}
                        sessionId={props.sessionId}
                        session={session}
                        jumpChildId={jumpChildId}
                    />
                </Deferred>
            </View>
        </>
    );
}
