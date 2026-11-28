import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePaneContentInsetPx } from '@/components/ui/lists/listPresentation';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { CheckoutReachabilityLine } from '@/components/workspaces/reachability/checkoutReachability';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { openGalleryStage } from '@/hooks/workspaces/files/gallery/galleryStage';
import { useSessionMediaCaptureScope } from '@/hooks/workspaces/files/gallery/useSessionMediaCaptureScope';
import { useSessionMediaModel } from '@/hooks/workspaces/files/gallery/useSessionMediaModel';
import { useShowGalleryItemInChat } from '@/hooks/workspaces/files/gallery/useShowGalleryItemInChat';
import type { GalleryMediaItem, GalleryMediaOrigin } from '@/hooks/workspaces/files/gallery/galleryModel';
import { Modal } from '@/modal';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { requestRegisteredComposerAttachmentPicker } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useActiveServerAccountScopeLifetime, useSessionDisplayNameSource } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { formatGalleryMoment, GalleryFootLine, GalleryGrid } from './GalleryGrid';

const NO_FOLDERS = [] as const;

export type SessionMediaGalleryViewProps = Readonly<{
  sessionId: string;
  serverId: string | null;
  /** `pane`: Files › Media. `tab`: the same gallery in a Details tab (lab SG2). */
  presentation: 'pane' | 'tab';
  onOpenFile?: ((path: string) => void) | null;
}>;

/**
 * This Session's pictures (lab pr974 SM1): what you attached, what the Agent made, tool output and screen captures,
 * flattened from their message folders and grouped by day. Listed only while shown; never polled.
 */
export function SessionMediaGalleryView(props: SessionMediaGalleryViewProps) {
  const { theme } = useUnistyles();
  const paneInset = usePaneContentInsetPx();
  const target = useSessionWorkspaceTarget(props.sessionId, props.serverId);
  const scope = React.useMemo(
    () =>
      target
        ? {
            serverId: target.serverId,
            machineId: target.machineId,
            rootPath: target.rootPath,
          }
        : null,
    [target?.serverId, target?.machineId, target?.rootPath],
  );
  const { machineRpcTargetAvailable } = useSessionMachineReachability(
    props.sessionId,
    props.serverId,
  );
  const viewerLifetime = useSessionViewerSourceAccountLifetime();
  const activeLifetime = useActiveServerAccountScopeLifetime(
    viewerLifetime === null,
  );
  const lifetime = viewerLifetime ?? activeLifetime;
  // The Session's resolved server: a chat jump and a marked copy's default Session both need it.
  const addressServerId = scope?.serverId ?? props.serverId ?? '';
  const address = React.useMemo(() => ({ sessionId: props.sessionId, serverId: addressServerId }), [addressServerId, props.sessionId]);
  const captureScope = useSessionMediaCaptureScope(
    scope?.serverId ?? props.serverId,
    scope?.machineId ?? null,
  );
  const model = useSessionMediaModel({
    scope,
    captureScope,
    sessionId: props.sessionId,
    enabled: true,
    online: machineRpcTargetAvailable,
    lifetime,
  });
  const showInChat = useShowGalleryItemInChat({ sessionId: props.sessionId, serverId: address.serverId }, lifetime);
  const stage = useMediaStage();
  const { items, failures, loadMore, pendingFolders, loadFolder, refresh } =
    model;
  const { onOpenFile } = props;
  const stageId = React.useRef<string | null>(null);
  // The tile of the item the person last opened or went to in the chat stays ringed (lab SM1j).
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null);
  const jumpToChat = React.useCallback(
    async (item: GalleryMediaItem) => {
      const result = await showInChat(item);
      if (result.ok) {
        setSelectedItemId(item.id);
        if (stageId.current) Modal.hide(stageId.current);
      } else if (result.code !== 'cancelled') {
        Modal.alert(t('files.pane.gallery.showInChatFailed'));
      }
    },
    [showInChat],
  );
  const openItem = React.useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      setSelectedItemId(item.id);
      const nowMs = Date.now();
      stageId.current = openGalleryStage(stage, items, item.id, (entry) => ({
        // Who made it and when, under the name (lab SM1s: "screen capture · today 13:51").
        subtitle: [describeMediaOrigin(entry.origin),
          entry.modifiedMs === undefined ? null : formatGalleryMoment(entry.modifiedMs, nowMs)]
          .filter((part): part is string => part !== null).join(' · '),
        ...(entry.messageLocalId
          ? {
              showInChat: () => {
                void jumpToChat(entry);
              },
            }
          : {}),
        ...(onOpenFile && entry.origin !== 'captures'
          ? { openFile: () => onOpenFile(entry.path) }
          : {}),
        ...(address.serverId ? { targetSession: address } : {}),
      }));
    },
    [address, items, jumpToChat, onOpenFile, stage],
  );
  // A real zero teaches the feature: its one next step is this Session's own composer picker (lab SM1z).
  const cockpit = useSessionCockpitSurfaceNavigation();
  const attachPicture = React.useCallback(() => {
    if (!lifetime?.isCurrent()) return;
    const scope = lifetime.scope;
    const pick = () => requestRegisteredComposerAttachmentPicker({ ref: { kind: 'session', sessionId: props.sessionId }, scope });
    // A phone shows the composer only on the chat surface: bring it forward, then open its picker once it is in front.
    if (!cockpit) { pick(); return; }
    cockpit.switchSurface('chat');
    requestAnimationFrame(pick);
  }, [cockpit, lifetime, props.sessionId]);
  const loadRest = React.useCallback(async () => {
    if (loadMore) await loadMore();
    else for (const folder of pendingFolders) await loadFolder(folder.id);
  }, [loadFolder, loadMore, pendingFolders]);

  const capturesRefused = failures.some(
    (failure) => failure.store === 'captures',
  );
  const listingFailed = failures.some(
    (failure) => failure.store !== 'captures',
  );
  const foot =
    model.incomplete || capturesRefused || !model.captureScopeAvailable ? (
      <>
        {model.incomplete ? (
          <GalleryFootLine
            icon="info"
            testID="media-truncated"
            text={t('files.pane.gallery.truncated', {
              count: formatExactCount(model.shownCount),
            })}
            action={
              loadMore || pendingFolders.length > 0
                ? {
                    label: t('files.pane.gallery.loadTheRest'),
                    onPress: () => {
                      void loadRest();
                    },
                    testID: 'media-load-more',
                  }
                : null
            }
          />
        ) : null}
        {capturesRefused || !model.captureScopeAvailable ? (
          <GalleryFootLine
            icon="monitor"
            testID="media-captures-unreadable"
            text={t('files.pane.gallery.capturesUnreadable')}
          />
        ) : null}
      </>
    ) : null;
  const inset = props.presentation === 'pane' ? paneInset : theme.space.s20;
  const nameSource = useSessionDisplayNameSource(props.sessionId, address.serverId || null);
  const sessionName = nameSource ? getSessionName(nameSource) : null;
  const countsKnown = !((model.loading || !machineRpcTargetAvailable) && items.length === 0);
  const header =
    props.presentation === 'tab' ? (
      <DetailsTabHeader
        testID="media-tab-header"
        title={t('files.pane.gallery.media')}
        leading={<Icon name="image" size={20} color={theme.colors.text.secondary} />}
        meta={[
          ...(sessionName ? [{ key: 'session', text: sessionName, tone: 'strong' as const, shrink: true }] : []),
          ...(countsKnown ? [{ key: 'count', text: t('files.pane.gallery.pictureCount', { count: model.shownCount }) }] : []),
          { key: 'order', text: t('files.pane.gallery.newestFirst'), tone: 'muted' as const },
        ]}
      />
    ) : null;

  return (
    <View style={styles.fill} testID={`session-media-${props.presentation}`}>
      {props.presentation === 'tab' && model.stale && scope ? (
        <CheckoutReachabilityLine scope={scope} testID="media-offline" />
      ) : null}
      {!machineRpcTargetAvailable && items.length === 0 && !model.stale ? (
        <View style={styles.fill}>
          {header}
          <RepositoryTreeRootErrorState kind="unavailable" machineName={null}
            machineScope={scope ? { serverId: scope.serverId, machineId: scope.machineId } : null} />
        </View>
      ) : listingFailed && items.length === 0 ? (
        <View style={styles.fill}>
          {header}
          <SurfaceStateCard
            kind="error"
            title={t('files.pane.gallery.mediaFailed')}
            diagnosticCode={failures[0]?.errorCode ?? null}
            action={{ label: t('common.retry'), onPress: refresh }}
            testID="media-failed"
          />
        </View>
      ) : (
        <GalleryGrid
          testID="session-media-grid"
          folders={NO_FOLDERS}
          sections={model.sections}
          loading={model.loading || !scope}
          stale={model.stale}
          header={header}
          foot={foot}
          insetPx={inset}
          onOpenItem={openItem}
          selectedItemId={selectedItemId}
          empty={
            <SurfaceStateCard
              kind="empty"
              iconName="image"
              title={t('files.pane.gallery.mediaEmptyTitle')}
              reason={t('files.pane.gallery.mediaEmptyReason')}
              action={{ label: t('files.pane.gallery.attachPicture'), onPress: attachPicture }}
              testID="media-empty"
            />
          }
        />
      )}
    </View>
  );
}

function describeMediaOrigin(origin: GalleryMediaOrigin): string | null {
  switch (origin) {
    case 'messages': return t('files.pane.gallery.originAttached');
    case 'generated': return t('files.pane.gallery.originGenerated');
    case 'artifacts': return t('files.pane.gallery.originToolOutput');
    case 'captures': return t('files.pane.gallery.originCapture');
    case 'folder': return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  grow: { flex: 1, minWidth: 0 },
}));
