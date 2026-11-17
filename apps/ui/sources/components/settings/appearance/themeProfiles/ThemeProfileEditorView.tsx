import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ThemeRadiusScaleName } from '@happier-dev/protocol/account/settings/themeProfiles';

import {
  ThemeMiniaturePreview,
  ThemePalettePreview,
  type ThemeMiniatureForm,
} from '@/components/settings/appearance/ThemeModePreview';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import { useDeviceType } from '@/utils/platform/responsive';
import { ThemeColorRow, ThemeColorTokenRow } from './ThemeColorTokenRow';
import type { ThemeLibraryPreview } from './themeLibraryViewTypes';
import type {
  ThemeEditorView,
  ThemeProfileEditorViewProps,
} from './themeProfileEditorViewTypes';

const RADIUS_CHOICES: readonly ThemeRadiusScaleName[] = [
  'sharp',
  'soft',
  'round',
];
const RADIUS_TITLE_KEYS = {
  sharp: 'settingsAppearance.themeProfiles.cornerSquare',
  soft: 'settingsAppearance.themeProfiles.cornerSoft',
  round: 'settingsAppearance.themeProfiles.cornerRound',
} as const satisfies Record<ThemeRadiusScaleName, string>;
/** The live preview beside the controls: a small window; on a phone a short strip (the app itself previews). */
const PREVIEW_ASPECT = { wide: 1.45, phone: 2 } as const;

/**
 * The theme editor (lab D1–D4): the theme's identity and one primary (Save and use) in the header,
 * then three views — Colors (start from, the two seeds, every colour), Style (corners, typeface) and
 * CSS — beside a live miniature. The app itself wears the draft as it changes.
 */
export const ThemeProfileEditorView = React.memo(
  function ThemeProfileEditorView(props: ThemeProfileEditorViewProps) {
    const phone = useDeviceType() === 'phone';
    const { header } = props;
  const onShare = header.onShare;
  // Share as plugin follows Export file; destructive rows stay last.
  const headerMenu = React.useMemo(() => {
    if (!onShare) return header.menu;
    const share = { id: 'share-plugin', title: t('settingsAppearance.themeProfiles.shareAsPlugin'), onSelect: onShare };
    const exportIndex = header.menu.findIndex((action) => action.id === 'export');
    const firstDestructive = header.menu.findIndex((action) => action.destructive === true);
    const at = exportIndex >= 0 ? exportIndex + 1 : firstDestructive >= 0 ? firstDestructive : header.menu.length;
    return [...header.menu.slice(0, at), share, ...header.menu.slice(at)];
  }, [header.menu, onShare]);
    const views = React.useMemo(
      () => [
        {
          id: 'colors' as const,
          label: t('settingsAppearance.themeProfiles.viewColors'),
        },
        {
          id: 'style' as const,
          label: t('settingsAppearance.themeProfiles.viewStyle'),
        },
        {
          id: 'css' as const,
          label: t('settingsAppearance.themeProfiles.viewCss'),
        },
      ],
      [],
    );

    const body =
      props.view === 'colors' ? (
        <ColorsView {...props} />
      ) : props.view === 'style' ? (
        <StyleView {...props} />
      ) : (
        <CssView {...props} />
      );
    // The CSS view puts the surface reference where the preview stands.
    const aside =
      props.view === 'css' ? (
        props.css.surfaces?.length ? (
          <SurfaceReference surfaces={props.css.surfaces} />
        ) : null
      ) : (
        <PreviewAside preview={props.preview} picker={props.picker} />
      );

    return (
      <ItemList
        testID="settings-theme-profile-editor"
        pageColumn="wide"
        style={{ paddingTop: 0 }}
        keyboardShouldPersistTaps="handled"
      >
        <PageHeader
          testID="settings-theme-profile-header"
          alwaysShowTitle
          title={header.title}
          description={header.description}
          meta={header.meta}
          details={
            header.error ? (
              <Text
                testID="settings-theme-profile-limit-error"
                accessibilityRole="alert"
                variant="meta"
                style={stylesheet.error}
              >
                {header.error}
              </Text>
            ) : undefined
          }
          leading={
            <View style={stylesheet.mark}>
              <EditorPreview preview={header.mark} form="mark" />
            </View>
          }
          primaryAction={
            header.save
              ? {
                  testID: 'settings-theme-profile-save',
                  title: t('settingsAppearance.themeProfiles.saveAndUse'),
                  disabled: header.save.disabled,
                  onPress: header.save.onPress,
                }
              : undefined
          }
          actions={
            <PageHeaderMenu
              testID="settings-theme-profile-menu"
              actions={headerMenu}
            />
          }
        />
        <ItemGroup surface="none">
          <SegmentedTabBar<ThemeEditorView>
            tabs={views}
            activeTabId={props.view}
            onSelectTab={props.onViewChange}
            testIDPrefix="settings-theme-profile-view"
          />
        </ItemGroup>
        {phone ? (
          <>
            {props.view === 'colors' ? (
              <ItemGroup surface="none">
                <View style={stylesheet.phoneStrip}>
                  <View
                    style={[
                      stylesheet.preview,
                      stylesheet.phoneStripPreview,
                      { aspectRatio: PREVIEW_ASPECT.phone },
                    ]}
                  >
                    <EditorPreview preview={props.preview} form="window" />
                  </View>
                  {props.picker ? <PickButton picker={props.picker} /> : null}
                </View>
                {props.picker?.active ? <PickBar picker={props.picker} /> : null}
              </ItemGroup>
            ) : null}
            {body}
          </>
        ) : (
          <View style={stylesheet.columns}>
            <View style={stylesheet.controls}>{body}</View>
            {aside ? <View style={stylesheet.aside}>{aside}</View> : null}
          </View>
        )}
      </ItemList>
    );
  },
);

/** The one miniature owner, from a header or a resolved palette. */
function EditorPreview(
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
}

/** The live miniature and, beside it, picking a colour from the app. */
function PreviewAside(
  props: Readonly<{
    preview: ThemeLibraryPreview;
    picker: ThemeProfileEditorViewProps['picker'];
  }>,
) {
  return (
    <View style={stylesheet.asideStack}>
      <View
        testID="settings-theme-profile-preview"
        style={[stylesheet.preview, { aspectRatio: PREVIEW_ASPECT.wide }]}
      >
        <EditorPreview preview={props.preview} form="window" />
      </View>
      <View style={stylesheet.previewCaption}>
        <Text variant="meta" style={[stylesheet.quiet, stylesheet.captionText]}>
          {props.picker?.active
            ? props.picker.target
              ? t('settingsAppearance.themeProfiles.pickTarget', {
                  surface: props.picker.target.surfaceLabel,
                  role: props.picker.target.roleLabel,
                })
              : t('settingsAppearance.themeProfiles.pickInstructionPointer')
            : t('settingsAppearance.themeProfiles.previewLive')}
        </Text>
        {props.picker ? <PickButton picker={props.picker} /> : null}
      </View>
      {props.picker?.active && props.picker.target ? (
        <Text variant="micro" style={[stylesheet.quiet, stylesheet.mono]}>
          {props.picker.target.roleId}
        </Text>
      ) : null}
    </View>
  );
}

/** Pick a colour from the app: one pressed toggle beside the preview, the same on every view. */
function PickButton(props: Readonly<{ picker: NonNullable<ThemeProfileEditorViewProps['picker']> }>) {
  return (
    <IconButton
      testID="settings-theme-profile-pick"
      iconName="crosshair"
      variant="plain"
      selected={props.picker.active}
      accessibilityLabel={t('settingsAppearance.themeProfiles.pickColor')}
      tooltip={t('settingsAppearance.themeProfiles.pickColor')}
      onPress={props.picker.onToggle}
    />
  );
}

/**
 * A phone has nothing to hover: while picking, one bar says how it works (tap a part of the app) and,
 * after a tap, what that part paints with; Done ends picking and returns to the colours.
 */
function PickBar(props: Readonly<{ picker: NonNullable<ThemeProfileEditorViewProps['picker']> }>) {
  const { target } = props.picker;
  return (
    <View testID="settings-theme-profile-pick-bar" accessibilityRole="summary" style={stylesheet.pickBar}>
      <Text variant="body" style={stylesheet.pickBarText}>
        {target
          ? t('settingsAppearance.themeProfiles.pickTarget', { surface: target.surfaceLabel, role: target.roleLabel })
          : t('settingsAppearance.themeProfiles.pickInstructionTouch')}
      </Text>
      <TextLinkButton
        testID="settings-theme-profile-pick-done"
        size="row"
        tone="strong"
        label={t('common.done')}
        onPress={props.picker.onToggle}
      />
    </View>
  );
}

function ColorsView(props: ThemeProfileEditorViewProps) {
  const { colors, seeds, readonly } = props;
  const query = colors.query.trim().toLowerCase();
  const groups = React.useMemo(
    () =>
      query.length === 0
        ? colors.groups
        : colors.groups
            .map((group) => ({
              ...group,
              tokens: group.tokens.filter((token) =>
                [token.id, token.label, token.description].some((text) =>
                  text.toLowerCase().includes(query),
                ),
              ),
            }))
            .filter((group) => group.tokens.length > 0),
    [colors.groups, query],
  );
  return (
    <>
      {props.details ? <DetailsGroup details={props.details} /> : null}
      {props.startFrom ? <StartFromGroup startFrom={props.startFrom} /> : null}
      <ItemGroup
        title={t('settingsAppearance.themeProfiles.seedsTitle')}
        description={t('settingsAppearance.themeProfiles.seedsDescription')}
      >
        <ThemeColorRow
          rowId="seed-canvas"
          title={t('settingsAppearance.themeProfiles.seedPage')}
          subtitle={
            seeds.canvasChanged
              ? t('settingsAppearance.themeProfiles.colorChanged')
              : t('settingsAppearance.themeProfiles.seedPageDescription')
          }
          value={seeds.canvas}
          changed={seeds.canvasChanged}
          invalid={colors.invalidByToken[`${colors.mode}:seed:canvas`] === true}
          readonly={readonly}
          recentColors={colors.recentColors}
          onChange={(value) => seeds.onChange('canvas', value)}
          onInvalidChange={(invalid) =>
            colors.onInvalidChange('seed:canvas', invalid)
          }
          onReset={() => seeds.onReset('canvas')}
        />
        <ThemeColorRow
          rowId="seed-accent"
          title={t('settingsAppearance.themeProfiles.seedAccent')}
          subtitle={
            seeds.accentChanged
              ? t('settingsAppearance.themeProfiles.colorChanged')
              : t('settingsAppearance.themeProfiles.seedAccentDescription')
          }
          value={seeds.accent}
          changed={seeds.accentChanged}
          invalid={colors.invalidByToken[`${colors.mode}:seed:accent`] === true}
          readonly={readonly}
          recentColors={colors.recentColors}
          onChange={(value) => seeds.onChange('accent', value)}
          onInvalidChange={(invalid) =>
            colors.onInvalidChange('seed:accent', invalid)
          }
          onReset={() => seeds.onReset('accent')}
        />
      </ItemGroup>
      <ItemGroup
        surface="none"
        title={t('settingsAppearance.themeProfiles.allColorsTitle')}
        description={t(
          readonly
            ? 'settingsAppearance.themeProfiles.colorsReadOnlyDescription'
            : 'settingsAppearance.themeProfiles.colorsDescription',
        )}
      >
        <CompactSearchField
          testID="settings-theme-profile-color-search"
          value={colors.query}
          onChangeText={colors.onQueryChange}
          placeholder={t('settingsAppearance.themeProfiles.findColor')}
          placement="page"
        />
      </ItemGroup>
      {groups.length === 0 ? (
        <ItemGroup surface="none">
          <Text variant="body" style={stylesheet.quiet}>
            {t('settingsAppearance.themeProfiles.noColorMatches')}
          </Text>
        </ItemGroup>
      ) : (
        groups.map((group) => (
          <ItemGroup key={group.id} title={group.title}>
            {group.tokens.map((token) => (
              <ThemeColorTokenRow
                key={token.id}
                profile={colors.draft}
                mode={colors.mode}
                token={token}
                invalid={
                  colors.invalidByToken[`${colors.mode}:${token.id}`] === true
                }
                readonly={readonly}
                recentColors={colors.recentColors}
                highlighted={colors.highlightedTokenId === token.id}
                onChange={colors.onChange}
                onInvalidChange={colors.onInvalidChange}
                onReset={colors.onReset}
              />
            ))}
          </ItemGroup>
        ))
      )}
    </>
  );
}

function DetailsGroup(
  props: Readonly<{
    details: NonNullable<ThemeProfileEditorViewProps['details']>;
  }>,
) {
  const { details } = props;
  return (
    <ItemGroup
      title={t('settingsAppearance.themeProfiles.detailsGroup')}
      description={t(
        'settingsAppearance.themeProfiles.detailsShortDescription',
      )}
    >
      <Item
        title={t('settingsAppearance.themeProfiles.themeName')}
        accessoryLayout="adaptive"
        showChevron={false}
        rightElement={
          <FieldTextInput
            testID="settings-theme-profile-name"
            value={details.name}
            onChangeText={details.onNameChange}
            accessibilityLabel={t('settingsAppearance.themeProfiles.themeName')}
            autoCapitalize="words"
            autoFocus={details.autoFocus}
            error={
              details.nameInvalid
                ? t('settingsAppearance.themeProfiles.invalidProfileName')
                : null
            }
          />
        }
      />
      <SegmentedChoiceItem<ThemeProfileMode>
        testID="settings-theme-profile-asset-appearance"
        testIDPrefix="settings-theme-profile-asset-appearance"
        title={t('settingsAppearance.themeProfiles.themeAppearance')}
        subtitle={t(
          'settingsAppearance.themeProfiles.themeAppearanceDescription',
        )}
        subtitleLines={0}
        options={[
          { id: 'light', label: t('settingsAppearance.themeOptions.light') },
          { id: 'dark', label: t('settingsAppearance.themeOptions.dark') },
        ]}
        value={details.appearance}
        onChange={details.onAppearanceChange}
      />
    </ItemGroup>
  );
}

/** One way to start: the themes the draft can take its colours from, each as its own miniature. */
function StartFromGroup(
  props: Readonly<{
    startFrom: NonNullable<ThemeProfileEditorViewProps['startFrom']>;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  const { startFrom } = props;
  const options = React.useMemo(
    (): Array<SelectionTile<string>> =>
      startFrom.options.map((option) => ({
        id: option.key,
        title: option.name,
        subtitle: option.sourceLabel,
        preview: (
          <EditorPreview
            preview={option.preview}
            form={phone ? 'phone' : 'window'}
          />
        ),
      })),
    [phone, startFrom.options],
  );
  return (
    <ItemGroup
      surface="none"
      title={t('settingsAppearance.themeProfiles.startFrom')}
      description={t('settingsAppearance.themeProfiles.startFromDescription')}
    >
      <SelectionTiles
        variant="visual"
        scroll="page"
        tileSizing="fill"
        maximumColumns={phone ? 2 : 4}
        previewAspectRatio={phone ? 1.1 : 1.6}
        labelLines={1}
        accessibilityLabel={t('settingsAppearance.themeProfiles.startFrom')}
        testIdPrefix="settings-theme-profile-start"
        value={startFrom.selectedKey}
        onChange={(next) => {
          if (next) startFrom.onChoose(next);
        }}
        options={options}
      />
    </ItemGroup>
  );
}

function StyleView(props: ThemeProfileEditorViewProps) {
  const { style } = props;
  const options = React.useMemo(
    (): Array<SelectionTile<ThemeRadiusScaleName>> =>
      RADIUS_CHOICES.map((radius) => ({
        id: radius,
        title: t(RADIUS_TITLE_KEYS[radius]),
        preview: (
          <EditorPreview preview={style.radiusPreview(radius)} form="window" />
        ),
      })),
    [style],
  );
  const [typefaceOpen, setTypefaceOpen] = React.useState(false);
  const typefaces = style.typefaces;
  const onTypefaceChange = style.onTypefaceChange;
  return (
    <>
      <ItemGroup
        surface="none"
        title={t('settingsAppearance.themeProfiles.cornersTitle')}
        description={t('settingsAppearance.themeProfiles.cornersDescription')}
      >
        <SelectionTiles
          variant="visual"
          tileSizing="fill"
          maximumColumns={3}
          previewAspectRatio={1.8}
          accessibilityLabel={t(
            'settingsAppearance.themeProfiles.cornersTitle',
          )}
          testIdPrefix="settings-theme-profile-corners"
          value={style.radius}
          onChange={(next) => {
            if (next && !props.readonly) style.onRadiusChange(next);
          }}
          options={options}
        />
      </ItemGroup>
      {typefaces && typefaces.length > 0 && onTypefaceChange ? (
        <ItemGroup>
          <DropdownMenu
            open={typefaceOpen}
            onOpenChange={setTypefaceOpen}
            items={[
              {
                id: '',
                title: t('settingsAppearance.themeProfiles.typefaceDefault'),
              },
              ...typefaces.map((face) => ({ id: face.id, title: face.label })),
            ]}
            selectedId={style.typeface ?? ''}
            onSelect={(id) => {
              setTypefaceOpen(false);
              onTypefaceChange(id === '' ? null : id);
            }}
            trigger={({ toggle }) => (
              <Item
                title={t('settingsAppearance.themeProfiles.typefaceTitle')}
                detail={
                  typefaces.find((face) => face.id === style.typeface)?.label ??
                  t('settingsAppearance.themeProfiles.typefaceDefault')
                }
                onPress={toggle}
              />
            )}
          />
        </ItemGroup>
      ) : null}
    </>
  );
}

function CssView(props: ThemeProfileEditorViewProps) {
  const [whichOpen, setWhichOpen] = React.useState(false);
  const { css } = props;
  const coverage = css.coverage;
  return (
    <ItemGroup
      surface="none"
      title={t('settingsAppearance.themeProfiles.cssTitle')}
      description={t('settingsAppearance.themeProfiles.cssDescription')}
    >
      {coverage && coverage.total > 0 ? (
        <View
          testID="settings-theme-profile-css-coverage"
          style={stylesheet.coverage}
        >
          <Text variant="meta" style={stylesheet.quiet}>
            {t('settingsAppearance.themeProfiles.cssCoverage', {
              native: coverage.native,
              total: coverage.total,
            })}
          </Text>
          {coverage.webOnly > 0 && css.webOnlyRules?.length ? (
            <TextLinkButton
              testID="settings-theme-profile-css-which"
              size="meta"
              tone="strong"
              expanded={whichOpen}
              label={t('settingsAppearance.themeProfiles.cssWhich', {
                count: coverage.webOnly,
              })}
              onPress={() => setWhichOpen((open) => !open)}
            />
          ) : null}
        </View>
      ) : null}
      {whichOpen && css.webOnlyRules?.length ? (
        <View testID="settings-theme-profile-css-web-only" style={stylesheet.webOnlyList}>
          {css.webOnlyRules.map((rule) => (
            <TextLinkButton
              key={`${rule.line}:${rule.selector}`}
              size="meta"
              tone="quiet"
              label={t('settingsAppearance.themeProfiles.cssWebOnlyRule', { line: rule.line, selector: rule.selector })}
              onPress={() => css.onRevealLine?.(rule.line)}
              disabled={!css.onRevealLine}
            />
          ))}
        </View>
      ) : null}
      <SectionContentRow>
        <View style={stylesheet.code}>
          <CodeEditor
            ref={css.editorRef}
            resetKey={css.resetKey}
            value={css.value}
            language="css"
            showLineNumbers
            readOnly={props.readonly}
            testID="settings-theme-profile-css"
            onChange={css.onChange}
          />
        </View>
      </SectionContentRow>
    </ItemGroup>
  );
}

/** Surfaces you can style: the stable names CSS addresses, and their parts. */
function SurfaceReference(
  props: Readonly<{
    surfaces: NonNullable<ThemeProfileEditorViewProps['css']['surfaces']>;
  }>,
) {
  return (
    <ItemGroup
      title={t('settingsAppearance.themeProfiles.surfacesTitle')}
      description={t('settingsAppearance.themeProfiles.surfacesDescription')}
    >
      {props.surfaces.map((surface) => (
        <Item
          key={surface.id}
          testID={`settings-theme-surface-${surface.id}`}
          title={surface.label}
          subtitle={
            surface.parts.length > 0
              ? `${surface.id} · ${surface.parts.join(', ')}`
              : surface.id
          }
          mode="info"
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  // The theme preview owns its shape; entity marks do not provide a backing tile.
  mark: {
    width: 44,
    height: 44,
    borderRadius: 11,
    overflow: 'hidden',
  },
  error: {
    color: theme.colors.state.danger.foreground,
  },
  columns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s32,
  },
  controls: {
    flex: 1,
    minWidth: 0,
  },
  aside: {
    width: 320,
    flexShrink: 0,
    paddingTop: theme.space.s24,
  },
  asideStack: {
    gap: theme.space.s8,
  },
  preview: {
    width: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  previewCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
  },
  quiet: {
    color: theme.colors.text.secondary,
  },
  phoneStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  phoneStripPreview: {
    flex: 1,
    width: undefined,
  },
  pickBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s12,
    paddingVertical: theme.space.s10,
    paddingHorizontal: theme.space.s16,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.selected,
  },
  pickBarText: {
    flex: 1,
    color: theme.colors.text.primary,
  },
  captionText: {
    flex: 1,
  },
  mono: {
    ...Typography.mono(),
  },
  webOnlyList: {
    alignItems: 'flex-start',
    gap: theme.space.s4,
    paddingBottom: theme.space.s8,
  },
  coverage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    paddingBottom: theme.space.s8,
  },
  code: {
    minHeight: 320,
    flex: 1,
  },
}));
