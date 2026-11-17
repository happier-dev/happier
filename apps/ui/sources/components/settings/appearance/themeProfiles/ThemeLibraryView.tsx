import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
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
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
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

const THEME_MODES: readonly ThemeProfileMode[] = ['light', 'dark'];

/** Wide: four themes across the reading column; a phone: two. Proportions of a small window, or a phone screen. */
const GRID = {
  wide: { columns: 4, aspect: 1.6, form: 'window' },
  phone: { columns: 2, aspect: 1.1, form: 'phone' },
} as const satisfies Record<
  string,
  { columns: number; aspect: number; form: ThemeMiniatureForm }
>;
const PHONE_SLOT_PREVIEW_ASPECT = 1.25;

/**
 * Appearance → Themes (lab A1 with MODE-ON-THEMES): the appearance mode, the mode slots (which theme each
 * mode uses), then each mode's themes in its own section, each drawn as its own miniature. A
 * press tries a theme on (Keep or Revert in the try bar); the ring alone marks the theme in use. Its quiet operations sit
 * behind its "…"; adding sits behind the header's one Add theme menu.
 */
export const ThemeLibraryView = React.memo(function ThemeLibraryView(
  props: ThemeLibraryViewProps,
) {
  const phone = useDeviceType() === 'phone';
  const { mode, onChooseMode, onChooseTheme } = props;
  const modeTitle = (slotMode: ThemeProfileMode) =>
    t(
      slotMode === 'dark'
        ? 'settingsAppearance.themeProfiles.darkModeSection'
        : 'settingsAppearance.themeProfiles.lightModeSection',
    );

  // Adaptive shows a slot for each mode; an explicit Light or Dark shows only the one the app wears (MODE-ON-THEMES).
  const appearanceMode = props.appearanceMode;
  const slotModes = appearanceMode === 'light' || appearanceMode === 'dark' ? [appearanceMode] : THEME_MODES;
  const slotOptions = React.useMemo(
    (): Array<SelectionTile<ThemeProfileMode>> =>
      slotModes.map((slotMode) => {
        const slot = props.slots[slotMode];
        return {
          id: slotMode,
          title: slot.name,
          subtitle: `${modeTitle(slotMode)} · ${slot.sourceLabel}`,
          // The mode this device shows now, said once at the slot's top end (lab A1).
          ...(slot.showing ? { status: t('settingsAppearance.themeProfiles.showingNow') } : {}),
          preview: (
            <LibraryPreview
              preview={slot.preview}
              form={phone ? 'phone' : 'window'}
            />
          ),
        };
      }),
    [phone, props.slots, appearanceMode],
  );

  const addMenu = <ThemeAddMenu items={props.addMenu} compact={phone} />;
  return (
    <ItemList testID="settings-theme-profiles-screen" style={{ paddingTop: 0 }}>
      <SettingsPageHeader
        description={t('settingsAppearance.themeProfiles.pageDescription')}
        actions={phone ? undefined : addMenu}
        navigationTrailing={phone ? addMenu : undefined}
      />

      {appearanceMode && props.onChangeAppearanceMode ? (
        // The one appearance-mode choice, the same setting the Appearance page shows (MODE-ON-THEMES).
        <ItemGroup>
          <SegmentedChoiceItem<ThemePreference>
            testIDPrefix="settings-theme-appearance-mode"
            title={t('settingsAppearance.theme')}
            options={APPEARANCE_MODES.map((option) => ({
              id: option,
              label: t(`settingsAppearance.themeOptions.${option}`),
              description: t(`settingsAppearance.themeDescriptions.${option}`),
            }))}
            value={appearanceMode}
            onChange={props.onChangeAppearanceMode}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup surface="none">
        <SettingAnchor setting={THEMES_SETTINGS.settings.lightTheme}>
          <SettingAnchor setting={THEMES_SETTINGS.settings.darkTheme}>
            <SelectionTiles
              variant="card"
              selectionMark="outline"
              // Two slots share a phone's row, so each leads with its preview; one slot (Light or Dark mode) has
              // the row to itself and keeps the desktop card, preview beside its name.
              density={phone && slotOptions.length > 1 ? 'regular' : 'compact'}
              descriptionPlacement={phone && slotOptions.length > 1 ? 'below' : 'beside'}
              previewAspectRatio={PHONE_SLOT_PREVIEW_ASPECT}
              minimumColumns={slotOptions.length}
              maximumColumns={slotOptions.length}
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

      <SettingAnchor setting={THEMES_SETTINGS.settings.yourThemes}>
        {props.sections ? (
          // One section per mode, every theme once (a two-mode theme sits in each of its modes' sections).
          props.sections.map((section, index) => (
            <ThemeSection key={section.mode} mode={section.mode} selectedKey={section.selectedKey} tiles={section.tiles}
              title={t(section.mode === 'dark' ? 'themeLibrary.darkThemes' : 'themeLibrary.lightThemes')}
              description={index === 0 && !props.hasOwnThemes ? t('settingsAppearance.themeProfiles.emptyDescription') : undefined}
              testID={index === 0 && !props.hasOwnThemes ? 'settings-theme-profile-custom-empty' : undefined}
              phone={phone} onChooseTheme={onChooseTheme} />
          ))
        ) : (
          <ThemeSection mode={mode} selectedKey={props.selectedKey} tiles={props.tiles} title={undefined}
            description={props.hasOwnThemes ? undefined : t('settingsAppearance.themeProfiles.emptyDescription')}
            testID={props.hasOwnThemes ? undefined : 'settings-theme-profile-custom-empty'}
            phone={phone} onChooseTheme={onChooseTheme} />
        )}
      </SettingAnchor>

      {props.onOpenStore ? (
        // One quiet onward line at the page foot (lab A1): no card under the bare tiles.
        <ItemGroup surface="none">
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

const APPEARANCE_MODES: readonly ThemePreference[] = ['adaptive', 'light', 'dark'];

/**
 * One mode's themes (lab A1 with MODE-ON-THEMES): a section title, then the visual picker: each theme its own
 * miniature (both faces for a two-mode theme), the ring alone on the one in use, the name and source centred
 * under it. It scrolls with the page and draws only the lines near the window.
 */
const ThemeSection = React.memo(function ThemeSection(props: Readonly<{
  mode: ThemeProfileMode;
  selectedKey: string;
  tiles: readonly ThemeLibraryTile[];
  title: string | undefined;
  description: string | undefined;
  /** The section that invites a first theme of your own carries the invitation's id. */
  testID?: string;
  phone: boolean;
  onChooseTheme: (key: string) => void;
}>) {
  const grid = props.phone ? GRID.phone : GRID.wide;
  const { onChooseTheme } = props;
  const options = React.useMemo(
    (): Array<SelectionTile<string>> =>
      props.tiles.map((tile) => ({
        id: tile.key,
        title: tile.name,
        subtitle: tile.sourceLabel,
        preview: <TilePreview tile={tile} form={grid.form} />,
      })),
    [grid.form, props.tiles],
  );
  const tilesByKey = React.useMemo(
    () => new Map(props.tiles.map((tile) => [tile.key, tile] as const)),
    [props.tiles],
  );
  return (
    <ItemGroup surface="none" title={props.title} description={props.description} testID={props.testID}>
      <SelectionTiles
        variant="visual"
        tileSizing="fill"
        scroll="page"
        maximumColumns={grid.columns}
        previewAspectRatio={grid.aspect}
        labelLines={1}
        accessibilityLabel={props.title ?? props.mode}
        testIdPrefix={`settings-theme-${props.mode}`}
        value={props.selectedKey}
        onChange={(next) => {
          if (next) onChooseTheme(next);
        }}
        options={options}
        renderOptionAccessory={({ option, revealed }) => {
          const tile = tilesByKey.get(option.id);
          return tile && revealed && (tile.menu.length > 0 || tile.onShare || tile.onDelete) ? (
            <TileMenu tile={tile} />
          ) : null;
        }}
      />
    </ItemGroup>
  );
});

/** A theme's miniature: its two faces side by side when it has both modes, else its one face. */
function TilePreview(props: Readonly<{ tile: ThemeLibraryTile; form: ThemeMiniatureForm }>) {
  const light = props.tile.previews?.light;
  const dark = props.tile.previews?.dark;
  if (props.tile.dual && light && dark) {
    return (
      <View style={stylesheet.faces}>
        <View style={stylesheet.face}><LibraryPreview preview={light} form={props.form} /></View>
        <View style={stylesheet.face}><LibraryPreview preview={dark} form={props.form} /></View>
      </View>
    );
  }
  return <LibraryPreview preview={props.tile.preview} form={props.form} />;
}

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

/** Under a slot: the way to send its theme to other devices. */
function SlotFooter(
  props: Readonly<{ slot: ThemeLibraryViewProps['slots'][ThemeProfileMode] }>,
) {
  const { slot } = props;
  if (!slot.onUseOtherDevices) return null;
  return (
    <View testID={`settings-theme-slot-${slot.mode}-footer`} style={stylesheet.slotFooter}>
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
  // Share as plugin after the file export; Delete last, in the danger tone.
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
  faces: {
    flex: 1,
    flexDirection: 'row',
  },
  face: {
    flex: 1,
    overflow: 'hidden',
  },
  slotFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s12,
    rowGap: theme.space.s4,
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
