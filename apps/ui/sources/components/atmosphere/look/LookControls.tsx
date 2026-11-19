import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import {
  ATMOSPHERE_DISSOLVES,
  ATMOSPHERE_LOOKS,
  resolveParams,
  type AtmosphereDissolveStyle,
  type AtmosphereEffectiveLook,
  type AtmosphereLook,
  type AtmospherePicture,
} from '@happier-dev/brand/atmosphere';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Slider } from '@/components/ui/forms/Slider';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { AtmosphereLookCopyKey } from '@/text/translations/glassAppearanceTranslations.shared';
import { ATMOSPHERE_PLANET_INTENSITIES, HOME_BACKGROUND_FIELD_MODES } from '@happier-dev/protocol/account/settings/accountSettings';
import type { GlyphFieldMode, PlanetIntensity } from '@happier-dev/brand/glyph-scene';
import { useSettingMutable } from '@/sync/store/hooks';
import type { PictureRecord } from '../pictureStore.types';
import type { AtmosphereEditor } from './atmosphereEditor';
import {
  changedPictureLookControls,
  effectivePictureLook,
  pictureLookKey,
  withLayout,
  withPicture,
  withPictureLook,
  withPlanet,
  withShuffledPicture,
  withSource,
  withoutPictureLook,
} from './atmosphereEdits';
import { PicturePicker } from './PicturePicker';
import {
  PictureImagePreview,
  PictureLookPreview,
  PlainPagePreview,
  PlanetSourcePreview,
  PlanetIntensityPreview,
} from './lookPreviews';
import { useBuiltinThumbnail, useStoredPictureBytes } from './usePictureBytes';

/**
 * The Look controls, shared by the Look panel (`panel`: compact blocks in a popover or sheet) and
 * Settings → Appearance → Glass and backdrop (`page`: rows of the section sheet). One set of
 * controls and one set of edits (`atmosphereEdits`); only the anatomy around them differs.
 */
export type LookPresentation = 'panel' | 'page';

/** The engine's catalogue order, Original first (lab `lookList`). */
const LOOKS: readonly AtmosphereLook[] = [
  'original',
  ...ATMOSPHERE_LOOKS.map((look) => look.id).filter((id) => id !== 'original'),
];
const INTENSITY_KEY = {
  quiet: 'planetQuiet',
  calm: 'planetCalm',
  full: 'planetFull',
} as const satisfies Record<PlanetIntensity, AtmosphereLookCopyKey>;
const LOOK_KEY = {
  original: 'lookOriginal',
  fine: 'lookFine',
  'painted-fine': 'lookPaintedFine',
  halftone: 'lookHalftone',
  mosaic: 'lookMosaic',
  painted: 'lookPainted',
  haze: 'lookHaze',
  engraving: 'lookEngraving',
} as const satisfies Record<AtmosphereLook, AtmosphereLookCopyKey>;
const FADE_KEY = {
  ordered: 'fadeOrdered',
  gradient: 'fadeGradient',
  haze: 'fadeHaze',
  shrink: 'fadeShrink',
  rows: 'fadeRows',
} as const satisfies Record<AtmosphereDissolveStyle, AtmosphereLookCopyKey>;
/** The lab's fade tiles show each dissolve across most of the tile. */
const FADE_TILE_RANGE = { from: 0.08, to: 0.96 } as const;

export const lookCopy = (key: AtmosphereLookCopyKey) =>
  t(`settingsAppearance.glassControls.${key}`);

function effectDefaults(id: AtmosphereLook): Record<string, number> {
  return resolveParams(ATMOSPHERE_LOOKS.find((look) => look.id === id));
}

/** A look tile previews that look with its own defaults, or the current params when it is the chosen one. */
function lookWithEffect(
  look: AtmosphereEffectiveLook,
  effect: AtmosphereLook,
): AtmosphereEffectiveLook {
  return effect === look.effect
    ? look
    : { ...look, effect, params: effectDefaults(effect) };
}

/**
 * One block of the Look panel, a row of the sheet (the first-open Home look sheet): its title, what the
 * choice means under it when the sheet says so, its control beneath, and a note under the control when
 * the choice needs one. It is the panel's switch row (`Item`) with the control below, so every block,
 * the glass ones included, shares one title, description and edge with Digits.
 */
export function LookPanelBlock(
  props: Readonly<{
    title: string;
    /** A live value or a small action at the header's end (Strength's percentage, Shuffle). */
    accessory?: React.ReactNode;
    /** A live value as text at the header's end (Strength's percentage); `accessory` wins when both are set. */
    value?: string;
    /** What the choice means, under the header and above the control. */
    description?: string;
    /** What the choice needs or does right now, under the control. */
    note?: string;
    testID?: string;
    children: React.ReactNode;
  }>,
) {
  return (
    <View testID={props.testID}>
      <Item
        title={props.title}
        subtitle={props.description}
        subtitleLines={0}
        showChevron={false}
        // The sheet's rows are separated by space alone (the Home look sheet draws no hairlines).
        showDivider={false}
        rightElement={props.accessory ?? (props.value !== undefined ? <Text style={styles.value}>{props.value}</Text> : undefined)}
        bottomElement={
          <View style={styles.panelBlock}>
            {props.children}
            {props.note ? <Text style={styles.note}>{props.note}</Text> : null}
          </View>
        }
      />
    </View>
  );
}

/** A Look choice between two or three short options: one full-width segmented control of equal segments. */
export function LookSegments<T extends string>(
  props: Readonly<{
    label: string;
    testIDPrefix: string;
    options: ReadonlyArray<Readonly<{ id: T; label: string; icon?: React.ReactNode }>>;
    value: T;
    onChange: (next: T) => void;
    disabled?: boolean;
  }>,
) {
  return (
    <SegmentedTabBar<T>
      role="radiogroup"
      accessibilityLabel={props.label}
      testIDPrefix={props.testIDPrefix}
      tabs={props.options}
      activeTabId={props.value}
      onSelectTab={props.onChange}
      segmentSizing="equal"
      iconPlacement="leading"
      disabled={props.disabled}
    />
  );
}

/** One block: a titled group in the panel; a searchable row with its description and its control beneath on the page. */
function LookBlock(
  props: Readonly<{
    presentation: LookPresentation;
    title: string;
    /** The page row's description: what the choice changes. */
    description: string;
    /** The panel shows the description under the title too (the Home look sheet's planet and field rows). */
    describeInPanel?: boolean;
    setting: SettingRef;
    /** A live value beside the title (Strength's percentage). */
    value?: string;
    /** A small action at the end of the title (Shuffle). */
    action?: React.ReactNode;
    testID?: string;
    children: React.ReactNode;
  }>,
) {
  if (props.presentation === 'page') {
    return (
      <SettingAnchor setting={props.setting}>
        <Item
          testID={props.testID}
          title={props.title}
          subtitle={props.description}
          subtitleLines={0}
          detail={props.value}
          showChevron={false}
          rightElement={props.action}
          bottomElement={<View style={styles.pageBlock}>{props.children}</View>}
        />
      </SettingAnchor>
    );
  }
  return (
    <LookPanelBlock
      testID={props.testID}
      title={props.title}
      accessory={props.action}
      value={props.value}
      description={props.describeInPanel ? props.description : undefined}
    >
      {props.children}
    </LookPanelBlock>
  );
}

/** Source: segmented in the panel (three short words); visual tiles on the page, where there is room. */
export function SourceControl(
  props: Readonly<{
    editor: AtmosphereEditor;
    presentation: LookPresentation;
    pictures: readonly AtmospherePicture[];
  }>,
) {
  const { value, update } = props.editor;
  if (props.presentation === 'panel') {
    return (
      <LookPanelBlock title={lookCopy('backdrop')}>
        <LookSegments
          label={lookCopy('backdrop')}
          testIDPrefix="look-source"
          options={[
            { id: 'planet', label: lookCopy('sourcePlanet') },
            { id: 'picture', label: lookCopy('sourcePicture') },
            { id: 'none', label: lookCopy('sourceNone') },
          ]}
          value={value.source}
          onChange={(source) => update((current) => withSource(current, source))}
        />
      </LookPanelBlock>
    );
  }
  const ref = value.picture.ref;
  const picture =
    ref.kind === 'builtin'
      ? (props.pictures.find((candidate) => candidate.id === ref.id) ?? null)
      : null;
  return (
    <LookBlock
      presentation="page"
      title={lookCopy('backdrop')}
      description={lookCopy('backdropDescription')}
      setting={APPEARANCE_SETTINGS.settings.atmosphereSource}
    >
      <SelectionTiles
        variant="visual"
        tileSizing="fill"
        labelLines={1}
        maximumColumns={3}
        previewAspectRatio={16 / 10}
        accessibilityLabel={lookCopy('backdrop')}
        testIdPrefix="look-source"
        options={[
          {
            id: 'planet',
            title: lookCopy('sourcePlanet'),
            subtitle: lookCopy('sourcePlanetNote'),
            preview: <PlanetSourcePreview intensity={value.planet.intensity} />,
          },
          {
            id: 'picture',
            title: lookCopy('sourcePicture'),
            subtitle: lookCopy('sourcePictureNote'),
            preview: <ChosenPictureThumbnail pictureRef={ref} picture={picture} />,
          },
          {
            id: 'none',
            title: lookCopy('sourceNone'),
            subtitle: lookCopy('sourceNoneNote'),
            preview: <PlainPagePreview />,
          },
        ]}
        value={value.source}
        onChange={(source) => {
          if (source) update((current) => withSource(current, source));
        }}
      />
    </LookBlock>
  );
}

function ChosenPictureThumbnail(
  props: Readonly<{
    pictureRef: AtmosphereEditor['value']['picture']['ref'];
    picture: AtmospherePicture | null;
  }>,
) {
  const builtin = useBuiltinThumbnail(props.picture);
  const own = useStoredPictureBytes(
    props.pictureRef.kind === 'user' ? props.pictureRef.localId : null,
  );
  return (
    <PictureImagePreview bytes={props.pictureRef.kind === 'user' ? own : builtin.status === 'present' ? builtin.bytes : null} />
  );
}

export function PlanetControls(
  props: Readonly<{
    editor: AtmosphereEditor;
    presentation: LookPresentation;
    /** Home's Background field row, between the intensity and the digits (the Home look sheet's order). */
    field?: React.ReactNode;
  }>,
) {
  const { value, update } = props.editor;
  const planet = value.planet;
  const label = t('settingsAppearance.glassControls.atmospherePlanetIntensity');
  const choices = ATMOSPHERE_PLANET_INTENSITIES.map(id => ({ id, label: lookCopy(INTENSITY_KEY[id]) }));
  const change = (intensity: PlanetIntensity) => update((current) => withPlanet(current, { intensity }));
  return (
    <>
      <LookBlock
        presentation={props.presentation}
        title={label}
        description={lookCopy('planetIntensityDescription')}
        describeInPanel
        setting={APPEARANCE_SETTINGS.settings.atmospherePlanetIntensity}
      >
        {props.presentation === 'page' ? (
          <SelectionTiles
            variant="visual"
            tileSizing="fill"
            labelLines={1}
            maximumColumns={3}
            previewAspectRatio={16 / 10}
            accessibilityLabel={label}
            testIdPrefix="look-intensity"
            options={choices.map(({ id, label: title }) => ({ id, title, preview: <PlanetIntensityPreview intensity={id} /> }))}
            value={planet.intensity}
            onChange={(intensity) => { if (intensity) change(intensity); }}
          />
        ) : (
          <LookSegments label={label} testIDPrefix="look-intensity" options={choices} value={planet.intensity} onChange={change} />
        )}
      </LookBlock>
      {props.field}
      <SettingAnchor
        setting={APPEARANCE_SETTINGS.settings.atmospherePlanetDigits}
      >
        <Item
          testID="look-digits"
          title={lookCopy('digits')}
          subtitle={lookCopy('digitsDescription')}
          showChevron={false}
          showDivider={props.presentation === 'panel' ? false : undefined}
          onPress={() =>
            update((current) =>
              withPlanet(current, { digits: !current.planet.digits }),
            )
          }
          rightElement={
            <Switch
              value={planet.digits}
              onValueChange={(digits) =>
                update((current) => withPlanet(current, { digits }))
              }
            />
          }
        />
      </SettingAnchor>
    </>
  );
}

const FIELD_KEY = {
  animated: 'fieldAnimated',
  still: 'fieldStill',
  off: 'fieldOff',
} as const satisfies Record<GlyphFieldMode, AtmosphereLookCopyKey>;

/**
 * Background field: the living dot field behind welcome and Home, an Account preference of its own
 * (`homeBackgroundField`), so choosing it re-renders no atmosphere reader. Home's Look only: a project
 * or a public profile has no field. Over a picture the row stays and says where the field shows (OQ3).
 */
export function BackgroundFieldControl(
  props: Readonly<{ presentation: LookPresentation; source: AtmosphereEditor['value']['source'] }>,
) {
  const [mode, setMode] = useSettingMutable('homeBackgroundField');
  const title = t('settingsAppearance.glassControls.homeBackgroundField');
  const description = lookCopy(props.source === 'picture' ? 'fieldPictureNote' : 'homeBackgroundFieldDescription');
  const options = HOME_BACKGROUND_FIELD_MODES.map(id => ({ id, label: lookCopy(FIELD_KEY[id]) }));
  const change = (next: GlyphFieldMode) => { if (next !== mode) setMode(next); };
  if (props.presentation === 'page') {
    return (
      <SettingAnchor setting={APPEARANCE_SETTINGS.settings.homeBackgroundField}>
        <SegmentedChoiceItem
          title={title}
          subtitle={description}
          subtitleLines={0}
          testIDPrefix="look-field"
          options={options}
          value={mode}
          onChange={change}
        />
      </SettingAnchor>
    );
  }
  return (
    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.homeBackgroundField}>
      <LookPanelBlock title={title} description={description} testID="look-field">
        <LookSegments label={title} testIDPrefix="look-field" options={options} value={mode} onChange={change} />
      </LookPanelBlock>
    </SettingAnchor>
  );
}

/** The chosen picture's bytes for the look previews: a built-in's thumbnail, or your own picture. */
function usePreviewSource(
  ref: AtmosphereEditor['value']['picture']['ref'],
  picture: AtmospherePicture | null,
): PictureRecord | null {
  const builtin = useBuiltinThumbnail(picture);
  const own = useStoredPictureBytes(ref.kind === 'user' ? ref.localId : null);
  const bytes = ref.kind === 'user' ? own : builtin.status === 'present' ? builtin.bytes : null;
  const key = pictureLookKey(ref);
  return React.useMemo(
    () =>
      bytes === null
        ? null
        : {
            localId: `preview:${key}`,
            kind: ref.kind,
            createdAtMs: 0,
            size: 0,
            data: bytes,
          },
    [bytes, key, ref.kind],
  );
}

export function PictureControls(
  props: Readonly<{
    editor: AtmosphereEditor;
    presentation: LookPresentation;
    pictures: readonly AtmospherePicture[];
  }>,
) {
  const { value, update } = props.editor;
  const { pictures, presentation } = props;
  const ref = value.picture.ref;
  const shownRef = props.editor.shownPictureRef ?? ref;
  const shownValue = { ...value, picture: { ...value.picture, ref: shownRef } };
  const picture =
    shownRef.kind === 'builtin'
      ? (pictures.find((candidate) => candidate.id === shownRef.id) ?? null)
      : null;
  const look = effectivePictureLook(shownValue, pictures);
  const source = usePreviewSource(shownRef, picture);
  const settings = APPEARANCE_SETTINGS.settings;
  return (
    <>
      <LookBlock
        presentation={presentation}
        title={t('settingsAppearance.glassControls.atmospherePictureRef')}
        description={lookCopy('pictureDescription')}
        setting={settings.atmospherePictureRef}
        action={
          <SectionActionButton
            testID="look-shuffle"
            title={lookCopy('shuffle')}
            icon="shuffle"
            onPress={() =>
              update((current) => withShuffledPicture(current, pictures, Math.random, shownRef))
            }
          />
        }
      >
        <PicturePicker
          pictureActions={props.editor.pictureActions}
          columns={presentation === 'page' ? 6 : 4}
          // The panel's two rows: six pictures, "Your picture…" and the rest of the gallery.
          collapsedCount={presentation === 'panel' ? 6 : undefined}
          pictures={pictures}
          selected={ref}
          onSelect={(next) => update((current) => withPicture(current, next))}
        />
      </LookBlock>
      <LookBlock
        presentation={presentation}
        title={lookCopy('look')}
        description={lookCopy('lookDescription')}
        setting={settings.atmosphereLooks}
      >
        <SelectionTiles
          variant="visual"
          tileSizing="fill"
          labelLines={1}
          maximumColumns={presentation === 'page' ? 8 : 5}
          previewAspectRatio={4 / 3}
          accessibilityLabel={lookCopy('look')}
          testIdPrefix="look-effect"
          options={LOOKS.map((id) => ({
            id,
            title: lookCopy(LOOK_KEY[id]),
            preview: source ? (
              <PictureLookPreview
                source={source}
                picture={picture}
                look={lookWithEffect(look, id)}
              />
            ) : null,
          }))}
          value={look.effect}
          onChange={(effect) => {
            if (effect)
              update((current) =>
                withPictureLook(current, { look: effect }, pictures, shownRef),
              );
          }}
        />
      </LookBlock>
      <LookBlock
        presentation={presentation}
        title={lookCopy('fade')}
        description={lookCopy('fadeDescription')}
        setting={settings.atmosphereLooks}
      >
        <SelectionTiles
          variant="visual"
          tileSizing="fill"
          labelLines={1}
          maximumColumns={5}
          previewAspectRatio={presentation === 'page' ? 4 / 3 : 1}
          accessibilityLabel={lookCopy('fade')}
          testIdPrefix="look-fade"
          options={ATMOSPHERE_DISSOLVES.map((dissolve) => ({
            id: dissolve.id,
            title: lookCopy(FADE_KEY[dissolve.id]),
            preview: source ? (
              <PictureLookPreview
                source={source}
                picture={picture}
                look={look}
                dissolve={{ style: dissolve.id, ...FADE_TILE_RANGE }}
              />
            ) : null,
          }))}
          value={look.fade}
          onChange={(dissolve) => {
            if (dissolve)
              update((current) =>
                withPictureLook(current, { dissolve }, pictures, shownRef),
              );
          }}
        />
      </LookBlock>
      <LookBlock
        presentation={presentation}
        title={lookCopy('strength')}
        description={lookCopy('strengthDescription')}
        setting={settings.atmosphereLooks}
        value={`${Math.round(look.strength * 100)}%`}
        testID="look-strength-block"
      >
        <Slider
          testID="look-strength"
          accessibilityLabel={lookCopy('strength')}
          min={0}
          max={1}
          step={0.01}
          value={look.strength}
          formatValueText={(next) => `${Math.round(next * 100)}%`}
          onValueChange={(next) =>
            update((current) =>
              withPictureLook(current, { strength: next }, pictures, shownRef),
            )
          }
          onValuePreview={(next) => props.editor.preview?.(next === undefined ? undefined : current =>
            withPictureLook(current, { strength: next }, pictures, shownRef))}
        />
      </LookBlock>
      <LayoutControl
        presentation={presentation}
        value={value.picture.layout}
        onChange={(layout) => update((current) => withLayout(current, layout))}
      />
      <ResetLookRow
        changed={changedPictureLookControls(shownValue)}
        onReset={() => update((current) => withoutPictureLook(current, shownRef))}
      />
    </>
  );
}

/** Layout: Horizon or Wallpaper, each with the lab's glyph in the panel; a row of the section on the page. */
function LayoutControl(
  props: Readonly<{
    presentation: LookPresentation;
    value: 'horizon' | 'wallpaper';
    onChange: (layout: 'horizon' | 'wallpaper') => void;
  }>,
) {
  const { theme } = useUnistyles();
  const glyph = (name: 'square-split-vertical' | 'sidebar-left-open') => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  const options = [
    { id: 'horizon' as const, label: lookCopy('layoutHorizon') },
    { id: 'wallpaper' as const, label: lookCopy('layoutWallpaper') },
  ];
  if (props.presentation === 'panel') {
    return (
      <SettingAnchor setting={APPEARANCE_SETTINGS.settings.atmospherePictureLayout}>
        <LookPanelBlock title={lookCopy('layout')}>
          <LookSegments
            label={lookCopy('layout')}
            testIDPrefix="look-layout"
            options={[
              { ...options[0], icon: glyph('square-split-vertical') },
              { ...options[1], icon: glyph('sidebar-left-open') },
            ]}
            value={props.value}
            onChange={props.onChange}
          />
        </LookPanelBlock>
      </SettingAnchor>
    );
  }
  return (
    <SettingAnchor setting={APPEARANCE_SETTINGS.settings.atmospherePictureLayout}>
      <SegmentedChoiceItem
        title={lookCopy('layout')}
        subtitle={lookCopy('layoutDescription')}
        subtitleLines={0}
        testIDPrefix="look-layout"
        options={options}
        value={props.value}
        onChange={props.onChange}
      />
    </SettingAnchor>
  );
}

function ResetLookRow(
  props: Readonly<{
    changed: ReadonlyArray<'look' | 'dissolve' | 'strength'>;
    onReset: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const dirty = props.changed.length > 0;
  const names = {
    look: lookCopy('look'),
    dissolve: lookCopy('fade'),
    strength: lookCopy('strength'),
  };
  return (
    <Item
      testID="look-reset"
      title={lookCopy('resetLook')}
      icon={
        <Icon
          name="arrow-arc-left"
          size={ICON_SIZE.sm}
          color={
            dirty ? theme.colors.text.secondary : theme.colors.text.tertiary
          }
        />
      }
      detail={
        dirty
          ? props.changed.map((key) => names[key]).join(' · ')
          : lookCopy('releaseLook')
      }
      disabled={!dirty}
      showChevron={false}
      onPress={dirty ? props.onReset : undefined}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // The control and its note share the row's text edge (the Item's bottom inset).
  panelBlock: { gap: theme.space.s6 },
  pageBlock: { alignSelf: 'stretch' },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  value: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
