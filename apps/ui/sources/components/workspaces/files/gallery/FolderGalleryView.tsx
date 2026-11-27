import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { usePaneContentInsetPx } from '@/components/ui/lists/listPresentation';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { CheckoutReachabilityLine } from '@/components/workspaces/reachability/checkoutReachability';
import { openGalleryStage } from '@/hooks/workspaces/files/gallery/galleryStage';
import { useFolderGalleryModel } from '@/hooks/workspaces/files/gallery/useFolderGalleryModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

import {
  GalleryFootLine,
  GalleryGrid,
  type GalleryFolder,
} from './GalleryGrid';

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export type FolderGalleryViewProps = Readonly<{
  scope: WorkspaceScopeBase;
  folderPath: string;
  /** The workspace root's name, the first crumb. */
  rootLabel: string;
  /** The Machine answers: off, the gallery keeps what it last listed and draws only cached pictures. */
  online: boolean;
  /** `pane`: the Files pane's path bar. `tab`: a Details tab's own header with the folder's facts (lab SG2). */
  presentation: 'pane' | 'tab';
  machineName?: string | null;
  onNavigate: (path: string) => void;
  onShowAsList: (path: string) => void;
  /** Moves this folder's gallery into the Details pane (lab SG2e); absent where there is no beside. */
  onOpenBeside?: ((path: string, event?: unknown) => void) | null;
  onOpenFile?: ((path: string) => void) | null;
  /** The Session a marked copy defaults to in the stage's chooser. */
  targetSession?: SessionAddress | null;
}>;

/** One folder as a gallery (lab pr974 SG1, SG2): folders first, pictures by day, the rest said in one line. */
export function FolderGalleryView(props: FolderGalleryViewProps) {
  const { theme } = useUnistyles();
  const paneInset = usePaneContentInsetPx();
  const model = useFolderGalleryModel({
    scope: props.scope,
    folderPath: props.folderPath,
    enabled: true,
    online: props.online,
  });
  const stage = useMediaStage();
  const {
    items,
    folders: folderNodes,
    otherFiles,
    incomplete,
    loadMore,
    failure,
    refresh,
    shownCount,
  } = model;
  const folders = React.useMemo<readonly GalleryFolder[]>(
    () => folderNodes.map((node) => ({ name: node.name, path: node.path })),
    [folderNodes],
  );
  const { onOpenFile, onNavigate, onShowAsList, onOpenBeside, folderPath } =
    props;
  const targetSession = props.targetSession ?? undefined;
  const openItem = React.useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      openGalleryStage(stage, items, item.id, (entry) => ({
        ...(onOpenFile ? { openFile: () => onOpenFile(entry.path) } : {}),
        ...(targetSession ? { targetSession } : {}),
      }));
    },
    [items, onOpenFile, stage, targetSession],
  );
  const openFolder = React.useCallback(
    (folder: GalleryFolder) => onNavigate(folder.path),
    [onNavigate],
  );
  const showAsList = React.useCallback(
    () => onShowAsList(folderPath),
    [folderPath, onShowAsList],
  );

  const crumbs = folderPath ? folderPath.split('/') : [];
  const name = crumbs.at(-1) ?? props.rootLabel;
  const upButton = (
    <IconButton
      variant="plain"
      size={28}
      iconName="arrow-up"
      disabled={!folderPath}
      accessibilityLabel={t('files.pane.gallery.up')}
      tooltip={t('files.pane.gallery.up')}
      onPress={() => onNavigate(parentPath(folderPath))}
      testID="gallery-up"
    />
  );
  const crumbLine = (
    <Text variant="meta" numberOfLines={1} style={styles.crumbs}>
      {[props.rootLabel, ...crumbs].map((crumb, index, all) => (
        <Text
          key={index}
          variant="meta"
          emphasis={index === all.length - 1 ? 'medium' : undefined}
          style={{
            color:
              index === all.length - 1
                ? theme.colors.text.primary
                : theme.colors.text.tertiary,
          }}
        >
          {index > 0 ? ' / ' : ''}
          {crumb}
        </Text>
      ))}
    </Text>
  );
  const beside = onOpenBeside ? (
    <IconButton
      variant="plain"
      size={28}
      iconName="square-split-horizontal"
      accessibilityLabel={t('files.pane.gallery.openBeside')}
      tooltip={t('files.pane.gallery.openBeside')}
      onPress={(event?: unknown) => onOpenBeside(folderPath, event)}
      testID="gallery-open-beside"
    />
  ) : null;
  const header =
    props.presentation === 'pane' ? (
      <View
        style={[
          styles.pathBar,
          { paddingHorizontal: paneInset - theme.space.s4 },
        ]}
        testID="gallery-path-bar"
      >
        {upButton}
        <View style={styles.grow}>{crumbLine}</View>
        {beside}
      </View>
    ) : (
      <View style={styles.tabHeader} testID="gallery-tab-header">
        <View style={styles.tabTitleRow}>
          <Icon name="folder" size={20} color={theme.colors.text.secondary} />
          <Text
            variant="title"
            emphasis="semiBold"
            numberOfLines={1}
            style={[styles.grow, { color: theme.colors.text.primary }]}
          >
            {name}
          </Text>
          {upButton}
        </View>
        <Text
          variant="meta"
          numberOfLines={1}
          style={{ color: theme.colors.text.tertiary }}
        >
          {crumbLine}
          {model.loading || (!props.online && !model.stale)
            ? ''
            : ` · ${t('files.pane.gallery.pictureCount', { count: shownCount })}`}
          {folders.length > 0
            ? ` · ${t('files.pane.gallery.folderCount', { count: folders.length })}`
            : ''}
        </Text>
      </View>
    );
  const inset = props.presentation === 'pane' ? paneInset : theme.space.s20;

  const foot =
    incomplete || otherFiles.length > 0 ? (
      <>
        {otherFiles.length > 0 ? (
          <GalleryFootLine
            icon="file"
            testID="gallery-other-files"
            text={t('files.pane.gallery.otherFiles', {
              count: otherFiles.length,
              names: otherFiles.map((file) => file.name).join(', '),
            })}
            action={{
              label: t('files.pane.gallery.showAsList'),
              onPress: showAsList,
              testID: 'gallery-show-as-list',
            }}
          />
        ) : null}
        {incomplete ? (
          <GalleryFootLine
            icon="info"
            testID="gallery-truncated"
            text={t('files.pane.gallery.truncated', {
              count: formatExactCount(
                shownCount + folders.length + otherFiles.length,
              ),
            })}
            action={
              loadMore
                ? {
                    label: t('files.pane.gallery.loadTheRest'),
                    onPress: loadMore,
                    testID: 'gallery-load-more',
                  }
                : null
            }
          />
        ) : null}
      </>
    ) : null;

  const failedEmpty = failure && items.length === 0 && folders.length === 0;
  // Out of reach with nothing listed yet: say so (the tree's FB1o state), never "no pictures".
  const unreachableEmpty = !props.online && !failure && items.length === 0 && folders.length === 0 && !model.stale;
  return (
    <View style={styles.fill} testID={`folder-gallery-${props.presentation}`}>
      {props.presentation === 'tab' && model.stale ? (
        <CheckoutReachabilityLine
          scope={props.scope}
          testID="gallery-offline"
        />
      ) : null}
      {unreachableEmpty ? (
        <View style={styles.fill}>
          {header}
          <RepositoryTreeRootErrorState kind="unavailable" machineName={props.machineName ?? null}
            machineScope={{ serverId: props.scope.serverId, machineId: props.scope.machineId }} />
        </View>
      ) : failedEmpty ? (
        <View style={styles.fill}>
          {header}
          <RepositoryTreeRootErrorState
            error={failure.errorCode ?? failure.error}
            onRetry={refresh}
            machineName={props.machineName ?? null}
            workspaceScope={props.scope}
          />
        </View>
      ) : (
        <GalleryGrid
          testID="folder-gallery-grid"
          folders={folders}
          sections={model.sections}
          loading={model.loading}
          stale={model.stale}
          header={header}
          foot={foot}
          insetPx={inset}
          onOpenFolder={openFolder}
          onOpenItem={openItem}
          empty={
            <SurfaceStateCard
              kind="empty"
              iconName="image"
              title={t('files.pane.gallery.emptyFolder')}
              action={{
                label: t('files.pane.gallery.showAsList'),
                onPress: showAsList,
              }}
              testID="gallery-empty"
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
  pathBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    minHeight: 32,
    paddingBottom: theme.space.s4,
  },
  crumbs: { color: theme.colors.text.tertiary },
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
