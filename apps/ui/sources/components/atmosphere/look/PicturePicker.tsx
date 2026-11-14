import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { HAPPIER_PRESS_FEEDBACK_V1, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import type { AtmospherePictureActions } from './atmosphereEditor';
import type { PictureInfo } from '../pictureStore.types';
import type { PictureRef } from './atmosphereEdits';
import { PictureImagePreview } from './lookPreviews';
import { pictureCreditLine, pictureTitle } from './pictureCredit';
import {
  useBuiltinThumbnail,
  useStoredPictureBytes,
  useUserPictures,
} from './usePictureBytes';

const ADD_TILE_ID = 'add-your-picture';
const MORE_TILE_ID = 'more-pictures';
const USER_PREFIX = 'user:';

function BuiltinThumbnail(props: Readonly<{ picture: AtmospherePicture }>) {
  const thumbnail = useBuiltinThumbnail(props.picture);
  return <PictureImagePreview bytes={thumbnail.status === 'present' ? thumbnail.bytes : null} />;
}
function UserThumbnail(props: Readonly<{ localId: string }>) {
  return <PictureImagePreview bytes={useStoredPictureBytes(props.localId)} />;
}
function MoreThumbnail(props: Readonly<{ label: string }>) {
  return (
    <View style={styles.add}>
      <Text style={styles.lineMeta} numberOfLines={1}>{props.label}</Text>
    </View>
  );
}
/**
 * The pictures a collapsed picker shows: the first `count` in catalog order, with the chosen one taking
 * the last place when it is further down, so the current picture is always in view.
 */
function collapsedPictures(
  pictures: readonly AtmospherePicture[],
  count: number,
  selected: PictureRef | null,
): readonly AtmospherePicture[] {
  const head = pictures.slice(0, count);
  const chosen = selected?.kind === 'builtin' ? pictures.find((picture) => picture.id === selected.id) : undefined;
  return !chosen || head.includes(chosen) ? head : [...head.slice(0, count - 1), chosen];
}
function AddThumbnail() {
  const { theme } = useUnistyles();
  return (
    <View style={styles.add}>
      <Icon
        name="image"
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
    </View>
  );
}

/**
 * Adding or removing a device picture: an admitted `settings.invoke` bound to the editor's captured
 * owner (Home, a project, or a public-profile draft). Settings selects an added picture for that owner.
 */
export function useAtmospherePictureAcquisition(pictureActions: AtmospherePictureActions | undefined) {
  const scope = useAccountSettingsScope();
  const execution = useMountedActionExecution(pictureActions?.target.serverId ?? scope, {
    executorOptions: pictureActions?.executorOptions,
    retainInvocation: true,
  });
  const add = React.useCallback(async () => {
    try {
      const result = await execution.execute('settings.invoke', {
        anchor: 'appearance.atmospherePictureAdd',
        ...(pictureActions ? { target: pictureActions.target } : {}),
        input: { kind: 'atmosphere_picture_add', source: { kind: 'picked' } },
      });
      if (!result.ok && !isActionApprovalDeclinedErrorCode(result.errorCode) && execution.isCurrent()) {
        await Modal.alertAsync(t('common.error'), t('common.unavailable'));
      }
    } catch (error) {
      if (!execution.isCurrent()) return;
      await Modal.alertAsync(
        t('common.error'),
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [execution.execute, execution.isCurrent, pictureActions]);
  const remove = React.useCallback(async (localId: string) => {
    const result = await execution.execute('settings.invoke', {
      anchor: 'appearance.atmospherePictureRemove',
      ...(pictureActions ? { target: pictureActions.target } : {}),
      input: { kind: 'atmosphere_picture_remove', localId },
    });
    if (!result.ok && !isActionApprovalDeclinedErrorCode(result.errorCode) && execution.isCurrent()) {
      await Modal.alertAsync(t('common.error'), t('common.unavailable'));
    }
  }, [execution.execute, execution.isCurrent, pictureActions]);
  return { add, remove };
}

/**
 * The built-in pictures (and plugin pictures) as thumbnails, this device's own pictures after them,
 * then "Your picture…". Choosing one selects it; the line below credits the chosen picture or, for
 * your own, says it stays on this device and offers to remove it.
 */
export const PicturePicker = React.memo(function PicturePicker(
  props: Readonly<{
    pictures: readonly AtmospherePicture[];
    selected: PictureRef | null;
    onSelect: (ref: PictureRef) => void;
    pictureActions?: AtmospherePictureActions;
    /** Thumbnails per row: four in the Look panel, more across a Settings page. */
    columns?: number;
    /**
     * The Look panel keeps its controls in view: it shows this many pictures, then "Your picture…" and a
     * tile that opens the whole gallery in place. Settings shows every picture.
     */
    collapsedCount?: number;
    testID?: string;
  }>,
) {
  const { onSelect } = props;
  const { add, remove } = useAtmospherePictureAcquisition(props.pictureActions);
  const userPictures = useUserPictures();
  const [expanded, setExpanded] = React.useState(false);
  const collapsed = !expanded && props.collapsedCount !== undefined && props.pictures.length > props.collapsedCount;
  const shown = React.useMemo(
    () => (collapsed ? collapsedPictures(props.pictures, props.collapsedCount!, props.selected) : props.pictures),
    [collapsed, props.pictures, props.collapsedCount, props.selected],
  );
  const hiddenCount = props.pictures.length - shown.length;
  const options = React.useMemo(
    (): Array<SelectionTile<string>> => [
      ...shown.map((picture) => ({
        id: picture.id,
        title: pictureTitle(picture),
        preview: <BuiltinThumbnail picture={picture} />,
      })),
      ...userPictures.map((info: PictureInfo) => ({
        id: `${USER_PREFIX}${info.localId}`,
        title: t('settingsAppearance.glassControls.yourPicture'),
        preview: <UserThumbnail localId={info.localId} />,
      })),
      {
        id: ADD_TILE_ID,
        title: t('settingsAppearance.glassControls.yourPictureAdd'),
        preview: <AddThumbnail />,
        previewEdge: 'dashed',
      },
      ...(hiddenCount > 0
        ? [{
            id: MORE_TILE_ID,
            title: t('common.more'),
            preview: <MoreThumbnail label={t('common.more')} />,
          }]
        : []),
    ],
    [shown, userPictures, hiddenCount],
  );
  const value =
    props.selected === null
      ? null
      : props.selected.kind === 'builtin'
        ? props.selected.id
        : `${USER_PREFIX}${props.selected.localId}`;
  const onChange = React.useCallback(
    (id: string | null) => {
      if (id === null) return;
      if (id === ADD_TILE_ID) {
        void add();
        return;
      }
      if (id === MORE_TILE_ID) {
        setExpanded(true);
        return;
      }
      onSelect(
        id.startsWith(USER_PREFIX)
          ? { kind: 'user', localId: id.slice(USER_PREFIX.length) }
          : { kind: 'builtin', id },
      );
    },
    [add, onSelect],
  );
  const selected = props.selected;
  const chosenUser =
    selected?.kind === 'user' && userPictures.some((info) => info.localId === selected.localId) ? selected.localId : null;
  const chosenBuiltin =
    selected?.kind === 'builtin' ? (props.pictures.find((picture) => picture.id === selected.id) ?? null) : null;
  return (
    <View style={styles.picker} testID={props.testID}>
      <SelectionTiles
        variant="visual"
        tileSizing="fill"
        labels="hidden"
        maximumColumns={props.columns ?? 4}
        previewAspectRatio={16 / 10}
        accessibilityLabel={t(
          'settingsAppearance.glassControls.atmospherePictureRef',
        )}
        testIdPrefix="atmosphere-picture"
        options={options}
        value={value}
        onChange={onChange}
      />
      {chosenBuiltin ? (
        <PictureCredit picture={chosenBuiltin} />
      ) : chosenUser ? (
        <UserPictureLine localId={chosenUser} onRemove={remove} />
      ) : null}
    </View>
  );
});

/** "Title · Photo · Author · Unsplash": the credit links to the picture's page at its source. */
function PictureCredit(props: Readonly<{ picture: AtmospherePicture }>) {
  const { picture } = props;
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      accessibilityRole="link"
      accessibilityLabel={`${pictureTitle(picture)} · ${pictureCreditLine(picture)}`}
      testID="atmosphere-picture-credit"
      // The picture tiles sit one picker gap above; the hit area stops at half of it.
      hitReach={{ top: theme.space.s8 / 2 }}
      onPress={() => {
        void openExternalUrl(picture.credit.url);
      }}
      style={({ focused, pressed }) => [
        styles.line,
        { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1 },
        focusRingStyle({ focused, color: theme.colors.border.focus }),
      ]}
    >
      {({ hovered }) => <Text style={[styles.lineMeta, hovered && { textDecorationLine: 'underline' }]} numberOfLines={2}>
          <Text style={styles.lineTitle}>{pictureTitle(picture)}</Text>
          {` · ${pictureCreditLine(picture)}`}
        </Text>}
    </HappierPressable>
  );
}

function UserPictureLine(props: Readonly<{ localId: string; onRemove(localId: string): Promise<void> }>) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineTitle} numberOfLines={1}>
        {t('settingsAppearance.glassControls.yourPicture')}
      </Text>
      <Text
        style={[styles.lineMeta, styles.grow]}
        numberOfLines={1}
      >{` · ${t('settingsAppearance.glassControls.yourPictureNote')}`}</Text>
      <TextLinkButton
        label={t('common.remove')}
        accessibilityLabel={t('settingsAppearance.glassControls.atmospherePictureRemove')}
        testID="atmosphere-picture-remove"
        onPress={() => props.onRemove(props.localId)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  picker: { gap: theme.space.s8 },
  add: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { flexDirection: 'row', alignItems: 'center' },
  grow: { flexShrink: 1, flexGrow: 1 },
  lineTitle: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.primary,
    
  },
  lineMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
}));
