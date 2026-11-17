import * as React from 'react';
import { Collection, type CollectionAnatomy, useHappierCollection } from '@happier-dev/plugin-ui';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  THEME_MINIATURE_CARD_MIN_WIDTH,
  ThemeMiniaturePreview,
  ThemePalettePreview,
  type ThemeMiniatureForm,
} from '@/components/settings/appearance/ThemeModePreview';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PLUGINS_SURFACE_ICON } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import { useDeviceType } from '@/utils/platform/responsive';
import { THEMES_SETTINGS } from './themesSettings';
import type {
  ThemeLibraryFact,
  ThemeLibraryMenuItem,
  ThemeLibraryNotice,
  ThemeLibraryPreview,
  ThemeLibraryTile,
  ThemeLibraryViewProps,
} from './themeLibraryViewTypes';

const themeTileKey = (tile: ThemeLibraryTile) => tile.key;
const passThroughScroller = (children: React.ReactNode) => children;

const THEME_MODES: readonly ThemeProfileMode[] = ['light', 'dark'];

/** Miniatures follow the device form; Collection owns the responsive grid geometry. */
const GRID = {
  wide: { aspect: 1.6, form: 'window' },
  phone: { aspect: 1.1, form: 'phone' },
} as const satisfies Record<
  string,
  { aspect: number; form: ThemeMiniatureForm }
>;
const PHONE_SLOT_PREVIEW_ASPECT = 1.25;

/**
 * Appearance → Themes (lab A1): the two mode slots (which theme light and dark mode use, the one this
 * device shows marked) over one grid of the chosen mode's themes, each drawn as its own miniature. A
 * press applies here at once; the ring alone marks the theme in use. A theme's quiet operations sit
 * behind its "…"; adding sits behind the header's one Add theme menu.
 */
export const ThemeLibraryView = React.memo(function ThemeLibraryView(
  props: ThemeLibraryViewProps,
) {
  const phone = useDeviceType() === 'phone';
  const grid = phone ? GRID.phone : GRID.wide;
  const { mode, onChooseMode, onChooseTheme } = props;
  const modeTitle = (slotMode: ThemeProfileMode) =>
    t(
      slotMode === 'dark'
        ? 'settingsAppearance.themeProfiles.darkModeSection'
        : 'settingsAppearance.themeProfiles.lightModeSection',
    );

  const slotOptions = React.useMemo(
    (): Array<SelectionTile<ThemeProfileMode>> =>
      THEME_MODES.map((slotMode) => {
        const slot = props.slots[slotMode];
        return {
          id: slotMode,
          title: slot.name,
          subtitle: `${modeTitle(slotMode)} · ${slot.sourceLabel}`,
          preview: (
            <LibraryPreview
              preview={slot.preview}
              form={phone ? 'phone' : 'window'}
            />
          ),
        };
      }),
    [phone, props.slots],
  );

  const model = useHappierCollection<ThemeLibraryTile>({
    items: props.tiles, keyOf: themeTileKey, openKey: null, onOpenChange: key => { if (key) onChooseTheme(key); },
  });
  const anatomy = React.useMemo<CollectionAnatomy<ThemeLibraryTile>>(() => ({
    glyph: () => null,
    title: tile => tile.name,
    where: tile => tile.sourceLabel,
    preview: tile => <View style={{ aspectRatio: grid.aspect }}><LibraryPreview preview={tile.preview} form={grid.form} /></View>,
    action: tile => tile.menu.length > 0 ? <TileMenu tile={tile} /> : null,
    accessibilityLabel: tile => tile.name,
    testID: tile => `settings-theme-${mode}:${tile.key}`,
    columnTitles: { title: modeTitle(mode) },
  }), [grid, mode]);

  const addMenu = <ThemeAddMenu items={props.addMenu} compact={phone} />;
  return (
    <ItemList testID="settings-theme-profiles-screen" style={{ paddingTop: 0 }}>
      <SettingsPageHeader
        description={t('settingsAppearance.themeProfiles.pageDescription')}
        actions={phone ? undefined : addMenu}
        navigationTrailing={phone ? addMenu : undefined}
      />

      <ItemGroup surface="none">
        <SettingAnchor setting={THEMES_SETTINGS.settings.lightTheme}>
          <SettingAnchor setting={THEMES_SETTINGS.settings.darkTheme}>
            <SelectionTiles
              variant="card"
              density={phone ? 'regular' : 'compact'}
              descriptionPlacement={phone ? 'below' : 'beside'}
              previewAspectRatio={PHONE_SLOT_PREVIEW_ASPECT}
              minimumColumns={2}
              maximumColumns={2}
              accessibilityLabel={t(
                'settingsAppearance.themeProfiles.modesLabel',
              )}
              testIdPrefix="settings-theme-slot"
              value={mode}
              onChange={(next) => {
                if (next) onChooseMode(next);
              }}
              options={slotOptions}
              renderOptionFooter={({ option }) => (
                <SlotFooter slot={props.slots[option.id]} />
              )}
            />
          </SettingAnchor>
        </SettingAnchor>
        {props.facts?.map((fact) => (
          <LibraryNoticeLine key={`${fact.kind}:${fact.name}`} notice={factNotice(fact)} />
        ))}
        {props.notice ? <LibraryNoticeLine notice={props.notice} /> : null}
      </ItemGroup>

      <ItemGroup surface="none">
        <SettingAnchor setting={THEMES_SETTINGS.settings.yourThemes}>
          <View style={stylesheet.grid}>
            {props.hasOwnThemes ? null : (
              <EmptyState
                layout="line"
                testID="settings-theme-profile-custom-empty"
                title={t('settingsAppearance.themeProfiles.emptyTitle')}
                subtitle={t(
                  'settingsAppearance.themeProfiles.emptyDescription',
                )}
                primaryAction={{
                  label: t('settingsAppearance.themeProfiles.newTheme'),
                  onPress: props.onNewTheme,
                  testID: 'settings-theme-profile-create-empty',
                }}
              />
            )}
            <CoreCollectionScope renderPageScroller={passThroughScroller}>
              <Collection<ThemeLibraryTile>
                testID={`settings-theme-${mode}-library`}
                model={model}
                anatomy={anatomy}
                accessibilityLabel={modeTitle(mode)}
                presentation="grid"
                minCardWidth={THEME_MINIATURE_CARD_MIN_WIDTH}
                detail="none"
                // Collection's page grid windows against ItemList's physical page tracker.
                scroll="page"
                minListWidth={280}
                minDetailWidth={280}
                preferredListRatio={1}
                selection={{ single: { value: props.selectedKey, onValueChange: next => { if (next) onChooseTheme(next); } } }}
              />
            </CoreCollectionScope>
          </View>
        </SettingAnchor>
      </ItemGroup>

      {props.onOpenStore ? (
        <ItemGroup>
          <Item
            testID="settings-theme-store"
            icon={<Icon name={PLUGINS_SURFACE_ICON} size={ICON_SIZE.md} />}
            title={t('settingsAppearance.themeProfiles.moreInStore')}
            subtitle={t(
              'settingsAppearance.themeProfiles.moreInStoreDescription',
            )}
            onPress={props.onOpenStore}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

/** The one miniature owner, from a library header or a resolved palette. */
const LibraryPreview = React.memo(function LibraryPreview(
  props: Readonly<{ preview: ThemeLibraryPreview; form: ThemeMiniatureForm }>,
) {
  const preview = props.preview;
  return preview.kind === 'miniature' ? (
    <ThemeMiniaturePreview miniature={preview.miniature} form={props.form} />
  ) : (
    <ThemePalettePreview
      palette={preview.palette}
      radius={preview.radius}
      accent={preview.accent}
      form={props.form}
    />
  );
});

/** Under a slot: whether this device shows that mode now, and the way to send its theme to other devices. */
function SlotFooter(
  props: Readonly<{ slot: ThemeLibraryViewProps['slots'][ThemeProfileMode] }>,
) {
  const { slot } = props;
  if (!slot.showing && !slot.onUseOtherDevices) return null;
  return (
    <View style={stylesheet.slotFooter}>
      {slot.showing ? (
        <Text variant="meta" style={stylesheet.meta}>
          {t('settingsAppearance.themeProfiles.showingNow')}
        </Text>
      ) : null}
      {slot.onUseOtherDevices ? (
        <View ref={slot.devicesAnchorRef as React.Ref<React.ElementRef<typeof View>>} collapsable={false}>
        <TextLinkButton
          testID={`settings-theme-slot-${slot.mode}-devices`}
          size="meta"
          tone="quiet"
          label={t('settingsAppearance.themeProfiles.useOnOtherDevices')}
          onPress={slot.onUseOtherDevices}
        />
        </View>
      ) : null}
    </View>
  );
}

/** The words for a fact about a theme in use, and its one repair. */
function factNotice(fact: ThemeLibraryFact): ThemeLibraryNotice {
  if (fact.kind === 'partial') {
    const summary = fact.webOnlyRules && !fact.unsupportedPaths?.length
      ? t('settingsAppearance.themeProfiles.partlyShownCss', { name: fact.name })
      : fact.requiresAppVersion
        ? t('settingsAppearance.themeProfiles.partlyShownVersion', { name: fact.name, version: fact.requiresAppVersion })
        : t('settingsAppearance.themeProfiles.partlyShown', { name: fact.name });
    return {
      text: [summary,
        ...(fact.unsupportedPaths?.length ? [t('settingsAppearance.themeProfiles.partlyShownOmitted', { parts: fact.unsupportedPaths.join(', ') })] : []),
        ...(fact.webOnlyRules ? [t('settingsAppearance.themeProfiles.partlyShownWebOnly', { count: fact.webOnlyRules })] : []),
      ].join(' '),
      ...(fact.onUpdate ? { action: { title: t('settingsAppearance.themeProfiles.updateHappier'), onPress: fact.onUpdate } } : {}),
    };
  }
  return {
    text: t('settingsAppearance.themeProfiles.hidesPart', { name: fact.name, areas: fact.areas.join(', ') }),
    action: { title: t('settingsAppearance.themeProfiles.useBuiltInTheme'), onPress: fact.onUseBuiltIn },
  };
}

/** One fact under both slots, with its one repair. */
function LibraryNoticeLine(
  props: Readonly<{ notice: NonNullable<ThemeLibraryViewProps['notice']> }>,
) {
  return (
    <View
      testID="settings-theme-notice"
      accessibilityRole="alert"
      style={stylesheet.notice}
    >
      <Text variant="meta" style={stylesheet.noticeText}>{props.notice.text}</Text>
      {props.notice.action ? (
        <TextLinkButton
          size="meta"
          tone="strong"
          label={props.notice.action.title}
          onPress={props.notice.action.onPress}
        />
      ) : null}
    </View>
  );
}

/** A theme's "…": its quiet operations, over the corner of its miniature. */
function TileMenu(props: Readonly<{ tile: ThemeLibraryTile }>) {
  const actions = React.useMemo(
    () =>
      props.tile.menu.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.disabled ? { disabled: true } : {}),
        ...(item.destructive ? { destructive: true } : {}),
        onSelect: item.onSelect,
      })),
    [props.tile.menu],
  );
  const { onShare, onDelete } = props.tile;
  // Share as plugin after the file export; Delete last, in the danger tone (its Action asks first).
  const verbs = React.useMemo(() => [
    ...actions,
    ...(onShare ? [{ id: 'share-plugin', title: t('settingsAppearance.themeProfiles.shareAsPlugin'), onSelect: onShare }] : []),
    ...(onDelete ? [{ id: 'delete', title: t('settingsAppearance.themeProfiles.deleteTheme'), destructive: true, onSelect: onDelete }] : []),
  ], [actions, onShare, onDelete]);
  return (
    <View style={stylesheet.tileMenu}>
      <PageHeaderMenu
        testID={`settings-theme-tile-menu-${props.tile.key}`}
        accessibilityLabel={t(
          'settingsAppearance.themeProfiles.themeActionsFor',
          { name: props.tile.name },
        )}
        actions={verbs}
      />
    </View>
  );
}

/** The header's one way to add: New theme · Import theme ("+" in a phone's navigation bar). */
function ThemeAddMenu(
  props: Readonly<{ items: readonly ThemeLibraryMenuItem[]; compact: boolean }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] =>
      props.items.map((item) => ({
        id: item.id,
        testID: `settings-theme-profile-${item.id}`,
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.disabled ? { disabled: true } : {}),
      })),
    [props.items],
  );
  return (
    <DropdownMenu
      testID="settings-theme-profile-add-menu"
      open={open}
      onOpenChange={setOpen}
      items={items}
      allowEmptySelection
      onSelect={(id) => {
        setOpen(false);
        props.items.find((item) => item.id === id)?.onSelect();
      }}
      placement="bottom"
      popoverAnchorAlign="end"
      matchTriggerWidth={false}
      maxWidthCap={320}
      showCategoryTitles={false}
      popoverPortalWebTarget="body"
      trigger={({ toggle }) =>
        props.compact ? (
          <IconButton
            testID="settings-theme-profile-add"
            iconName="plus"
            variant="plain"
            accessibilityLabel={t('settingsAppearance.themeProfiles.addTheme')}
            onPress={toggle}
            expanded={open}
            hasPopup="menu"
          />
        ) : (
          <RoundButton
            testID="settings-theme-profile-add"
            size="small"
            display="inverted"
            title={t('settingsAppearance.themeProfiles.addTheme')}
            leading={
              <Icon
                name="plus"
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            }
            textStyle={{ color: theme.colors.text.secondary }}
            onPress={toggle}
          />
        )
      }
    />
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  grid: {
    gap: theme.space.s12,
  },
  slotFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s12,
    rowGap: theme.space.s4,
  },
  meta: {
    color: theme.colors.text.secondary,
  },
  notice: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s4,
    paddingTop: theme.space.s12,
  },
  noticeText: {
    color: theme.colors.state.warning.foreground,
  },
  // A floating control over the miniature: the menu's surface and hairline keep it legible on any theme.
  tileMenu: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
}));
