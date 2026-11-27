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
import type { GalleryMediaItem } from '@/hooks/workspaces/files/gallery/galleryModel';
import { Modal } from '@/modal';
import { requestRegisteredComposerAttachmentPicker } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { GalleryFootLine, GalleryGrid } from './GalleryGrid';

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
  const jumpToChat = React.useCallback(
    async (item: GalleryMediaItem) => {
      const result = await showInChat(item);
      if (result.ok) {
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
      stageId.current = openGalleryStage(stage, items, item.id, (entry) => ({
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
  const attachPicture = React.useCallback(() => {
    if (!lifetime?.isCurrent()) return;
    requestRegisteredComposerAttachmentPicker({ ref: { kind: 'session', sessionId: props.sessionId }, scope: lifetime.scope });
  }, [lifetime, props.sessionId]);
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
  const header =
    props.presentation === 'tab' ? (
      <View style={styles.tabHeader} testID="media-tab-header">
        <View style={styles.tabTitleRow}>
          <Icon name="image" size={20} color={theme.colors.text.secondary} />
          <Text
            variant="title"
            emphasis="semiBold"
            numberOfLines={1}
            style={[styles.grow, { color: theme.colors.text.primary }]}
          >
            {t('files.pane.gallery.media')}
          </Text>
        </View>
        {(model.loading || !machineRpcTargetAvailable) && items.length === 0 ? null : (
          <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>
            {t('files.pane.gallery.pictureCount', { count: model.shownCount })}
          </Text>
        )}
      </View>
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

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  grow: { flex: 1, minWidth: 0 },
  tabHeader: {
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s20,
    paddingTop: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  tabTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
