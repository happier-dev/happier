import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter, useIsFocused, type Href } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { normalizeSessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Icon } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { DiscussionDetailsView } from '@/components/discussions/DiscussionDetailsView';
import { DiscussionsColumn } from './DiscussionsColumn';
import { DiscussionPaneHost } from './DiscussionRightSidebar';
import { useOpenDiscussion } from './useOpenDiscussion';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildDiscussionRouteHref, buildDiscussionsRouteHref, readDiscussionRouteAnchor, readDiscussionRouteDraftId } from './discussionRoutes';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { useArtifact, useSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { normalizeDiscussionMobileSurface } from '@/components/workspaceCockpit/discussion/discussionCockpitState';
import { randomUUID } from '@/platform/randomUUID';

const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1 },
    // The index page's invitation sits in the middle of the page (lab T2-E).
    indexPage: { flex: 1, justifyContent: 'center' },
    headerButton: { minWidth: HAPPIER_PAGE_METRICS.controlHeightPx, minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, alignItems: 'center', justifyContent: 'center' },
    headerBackLabelled: { flexDirection: 'row', gap: theme.space.s8 },
    headerBackLabel: { flexShrink: 1 },
}));

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const normalized = raw?.trim() ?? '';
    return normalized ? normalized : null;
}

export function DiscussionRouteScreen(props: Readonly<{
    kind: 'list' | 'new' | 'discussion' | 'conversation';
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        serverId?: string | string[];
        discussionId?: string | string[];
        messageId?: string | string[];
        sourceSurface?: string | string[];
        anchor?: string | string[];
        anchorSessionId?: string | string[];
        anchorMessageId?: string | string[];
        returnArtifactId?: string | string[];
        draftId?: string | string[];
        mobileSurface?: string | string[];
    }>();
    const explicitServerId = readSessionRouteServerId(params);
    // An unqualified Home launcher captures its destination once. Changing the
    // selected Home cannot retarget a retained draft or in-flight operation.
    const [capturedServerId] = React.useState(() => explicitServerId ?? getActiveServerAccountScope()?.serverId ?? null);
    const requestedServerId = explicitServerId ?? capturedServerId;
    const requestedServerIds = React.useMemo(
        () => requestedServerId ? [requestedServerId] : NO_SERVER_IDS,
        [requestedServerId],
    );
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const serverId = binding?.scope.serverId ?? requestedServerId;
    const address = React.useMemo(() => serverId ? { serverId } : null, [serverId]);
    const discussionId = readParam(params.discussionId);
    const kind = props.kind === 'conversation' ? discussionId ? 'discussion' : 'new' : props.kind;
    const messageId = readParam(params.messageId);
    const routeDraftId = readDiscussionRouteDraftId(params.draftId);
    const [entryDraftId] = React.useState(randomUUID);
    const draftId = kind === 'new' && routeDraftId === undefined ? entryDraftId : routeDraftId;
    const anchorSessionId = readParam(params.anchorSessionId);
    const anchorMessageId = readParam(params.anchorMessageId);
    const anchorParam = readParam(params.anchor);
    const anchor = React.useMemo(() => readDiscussionRouteAnchor({ serverId,
        anchor: anchorParam, anchorSessionId, anchorMessageId }), [anchorMessageId, anchorParam, anchorSessionId, serverId]);
    // A pushed Run or another route keeps this screen mounted underneath; only the
    // focused route is the visible Discussion surface for read and presence.
    const routeFocused = useIsFocused();
    const sourceSurface = normalizeSessionMobileSurface(readParam(params.sourceSurface)) ?? 'discussions';
    // Opened from a passage in a Doc: Back names that Doc and returns to it (lab K1-Ap).
    const returnArtifactId = readParam(params.returnArtifactId);
    const returnArtifact = useArtifact(returnArtifactId ?? '');
    const returnLabel = returnArtifactId && returnArtifact ? (returnArtifact.title || t('artifacts.untitled')) : null;
    const fallbackHref = returnArtifactId ? artifactViewRoute(returnArtifactId)
        : serverId ? buildDiscussionsRouteHref({ serverId }) : '/';
    React.useEffect(() => {
        if (explicitServerId && (kind !== 'new' || params.draftId !== undefined)
            || !address || anchor === null || kind === 'new' && draftId === null) return;
        const href = kind === 'list'
            ? buildDiscussionsRouteHref(address)
            : kind === 'new'
                ? buildDiscussionRouteHref({ target: { kind: 'new', address, ...(draftId ? { draftId } : {}), ...(anchor ? { anchor } : {}) }, sourceSurface,
                    ...(returnArtifactId ? { returnArtifactId } : {}) })
                : discussionId
                    ? buildDiscussionRouteHref({ target: { kind: 'discussion', address, discussionId, ...(messageId ? { messageId } : {}) }, sourceSurface, ...(returnArtifactId ? { returnArtifactId } : {}) })
                    : null;
        if (href) router.replace(href as Href);
    }, [address, anchor, discussionId, draftId, messageId, explicitServerId, params.draftId, kind, returnArtifactId, router, sourceSurface]);
    const onBack = React.useCallback(() => safeRouterBack({
        router,
        navigation,
        fallbackHref: fallbackHref as Href,
    }), [fallbackHref, navigation, router]);
    const headerLeft = React.useCallback(() => (
        <HappierPressable
            accessibilityRole="button"
            accessibilityLabel={returnLabel ?? t('common.back')}
            testID="session-discussion-back"
            onPress={onBack}
            style={({ pressed }) => [styles.headerButton, returnLabel ? styles.headerBackLabelled : null,
                pressed ? { opacity: motionTokens.press.opacity } : null]}
        >
            <Icon name="arrow-left" size={20} color={theme.colors.chrome.header.foreground} />
            {returnLabel ? (
                <Text variant="body" emphasis="medium" numberOfLines={1} style={[styles.headerBackLabel, { color: theme.colors.chrome.header.foreground }]}>
                    {returnLabel}
                </Text>
            ) : null}
        </HappierPressable>
    ), [onBack, returnLabel, theme.colors.chrome.header.foreground]);
    // Valid draft and thread surfaces own the same navigation band. Invalid draft
    // parameters still need the route's way back because no conversation can mount.
    const columnVisible = useAppShellColumn().columnVisible;
    // The mounted Discussion lends this presentation to both phone chrome presenters.
    const deviceType = useDeviceType();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const phoneSurfaces = !columnVisible && isMobileWorkspaceCockpitEnabled({ deviceType, mobileWorkspaceExperience });
    const mobileSurface = normalizeDiscussionMobileSurface(readParam(params.mobileSurface)) ?? 'chat';
    const screenOptions = React.useMemo(() => ({
        headerShown: !columnVisible && kind === 'new' && (!address || anchor === null || draftId === null),
        // The labelled Back already says where this thread lives; a second title would repeat it.
        headerTitle: returnLabel ? '' : kind === 'new'
            ? t('session.collaboration.discussion.newDiscussion')
            : t('session.collaboration.discussion.title'),
        headerLeft,
    }), [address, anchor, columnVisible, draftId, headerLeft, kind, returnLabel]);

    return (
        <View style={styles.root}>
            <Stack.Screen options={screenOptions} />
            <SurfaceStateSizeProvider size={deviceType === 'phone' ? 'phone' : 'page'}>
            {!address || (kind === 'new' && (anchor === null || draftId === null)) || (kind === 'discussion' && !discussionId) ? (
                <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />
            ) : kind === 'list' ? (
                !columnVisible
                    ? <DiscussionsColumn surface="page" />
                    : binding
                        ? <DiscussionsIndexPage address={address} binding={binding} />
                        : <SurfaceStateCard kind="unavailable" title={t('sessionConversation.discussion.unavailableTitle')} />
            ) : (
                <DiscussionPaneHost discussionId={kind === 'discussion' ? discussionId! : undefined} scope={binding?.scope ?? null}
                    paneEnabled={deviceType !== 'phone' && kind === 'discussion'}
                    phoneSurface={phoneSurfaces && kind === 'discussion' ? mobileSurface : null}
                    onSurfaceChange={surface => router.setParams({ mobileSurface: surface === 'chat' ? undefined : surface })}
                    onBackToThread={() => router.setParams({ mobileSurface: undefined })}
                    main={<DiscussionDetailsView
                        target={kind === 'new'
                            ? { kind: 'new', address, ...(draftId ? { draftId } : {}), ...(anchor ? { anchor } : {}) }
                            : { kind: 'discussion', address, discussionId: discussionId!, ...(messageId ? { messageId } : {}) }}
                        active={routeFocused} standaloneSurface onClose={onBack}
                        onCreated={(discussion, passageRoot) => router.replace(buildDiscussionRouteHref({
                            target: { kind: 'discussion', address, discussionId: discussion.id,
                                ...(passageRoot ? { messageId: passageRoot.messageId } : {}) },
                            sourceSurface, ...(returnArtifactId ? { returnArtifactId } : {}),
                        }) as Href)}
                    />} />
            )}
            </SurfaceStateSizeProvider>
        </View>
    );
}

/**
 * `/discussions` beside the column (lab T2-E): with none yet, the page invites the first one; otherwise
 * it asks which to open. It never opens one by itself, because opening a Discussion reads it.
 */
function DiscussionsIndexPage(props: Readonly<{ address: Readonly<{ serverId: string }>; binding: ServerCredentialAccountScopeBinding }>) {
    const { scope } = props.binding;
    const client = React.useMemo(() => createDiscussionClient({ scope, availability: 'available' }), [scope]);
    const repository = React.useMemo(() => getDiscussionRepository({
        scope, address: props.address, client, accountLifetime: props.binding,
    }), [client, props.address, props.binding, scope]);
    useDiscussionRepositorySnapshot(repository);
    const active = repository.getListSnapshot().lists.active;
    const { openNewDiscussion } = useOpenDiscussion({ address: props.address, sourceSurface: 'discussions' });
    if (active.items.length === 0 && (active.status === 'idle' || active.status === 'loading')) return null;
    const none = active.items.length === 0 && active.status === 'ready';
    return (
        <View style={styles.indexPage}>
        <EmptyState
            testID={none ? 'discussions-index-invite' : 'discussions-index-idle'}
            layout="centered"
            scene="invitePeople"
            title={none ? t('session.collaboration.discussion.home.inviteTitle') : t('session.collaboration.discussion.home.idleTitle')}
            subtitle={none ? t('session.collaboration.discussion.home.inviteBody') : t('session.collaboration.discussion.home.idleBody')}
            primaryAction={{ label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
        />
        </View>
    );
}
