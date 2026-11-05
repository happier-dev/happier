import * as React from 'react';
import {
  ATMOSPHERE_PLACES,
  type AtmospherePlace,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';
import type { AtmosphereLookCopyKey } from '@/text/translations/glassAppearanceTranslations.shared';
import type { AtmosphereEditor } from './atmosphereEditor';
import {
  LookPanelBlock,
  LookSegments,
  lookCopy,
  type LookPresentation,
} from './LookControls';
import {
  atmosphereShowOnMode,
  atmosphereShowOnPlaces,
  isAtmospherePlaceAvailable,
  type AtmosphereShowOnMode,
} from './atmosphereShowOn';

const PLACE_COPY = {
  home: 'placeHome',
  'new-session': 'placeNewSession',
  projects: 'placeProjects',
  sessions: 'showOnSessions',
  pages: 'placePages',
} as const satisfies Record<AtmospherePlace, AtmosphereLookCopyKey>;

const NOWHERE: readonly AtmospherePlace[] = [];

const MODES = [
  { id: 'everywhere', key: 'showOnEverywhere' },
  { id: 'home', key: 'showOnHomeOnly' },
  { id: 'custom', key: 'showOnCustom' },
] as const satisfies ReadonlyArray<
  Readonly<{ id: AtmosphereShowOnMode; key: AtmosphereLookCopyKey }>
>;

/** The editor's place set read as a mode, and the one write a mode choice makes (plan A3). */
export type AtmosphereShowOn = Readonly<{
  showOn: readonly AtmospherePlace[];
  source: AtmosphereEditor['value']['source'];
  mode: AtmosphereShowOnMode;
  choose(mode: AtmosphereShowOnMode): void;
  commitPlaces(places: AtmospherePlace[]): void;
}>;

/**
 * "Show background on": Everywhere, Home only, or Custom with the places to pick. Both presentations write the
 * editor's place set, so a Project's Look writes that Project. Null for an editor without places (a public profile).
 */
export function useAtmosphereShowOn(editor: AtmosphereEditor): AtmosphereShowOn | null {
  const showOn = editor.showOn ?? NOWHERE;
  const setShowOn = editor.setShowOn;
  const source = editor.value.source;
  // Custom is a choice of its own even while the picked set happens to read as Everywhere or Home only.
  const [customChosen, setCustomChosen] = React.useState(false);
  if (!setShowOn) return null;
  return {
    showOn,
    source,
    mode: customChosen ? 'custom' : atmosphereShowOnMode(showOn, source),
    choose: (next) => {
      setCustomChosen(next === 'custom');
      // A choice can reverse an in-flight commit while showOn still renders its old value.
      // The Settings/Project-row owner decides equality against its fresh value.
      if (next !== 'custom') setShowOn(atmosphereShowOnPlaces(next, showOn));
    },
    commitPlaces: (places) => setShowOn(places),
  };
}

/** The mode choice: a field select on the page, segments in Look. */
export function AtmosphereShowOnSelector(
  props: Readonly<{ state: AtmosphereShowOn; presentation: LookPresentation }>,
) {
  const { state } = props;
  const [open, setOpen] = React.useState(false);
  const title = lookCopy('showOn');
  // The Planet cannot show on Sessions or other pages, so there Everywhere is only these three places.
  const planetPlaces = state.source === 'planet' ? lookCopy('showOnEverywherePlanet') : undefined;
  const selector =
    props.presentation === 'panel' ? (
      <LookPanelBlock title={title} testID="look-show-on" note={state.mode === 'everywhere' ? planetPlaces : undefined}>
        <LookSegments<AtmosphereShowOnMode>
          label={title}
          testIDPrefix="look-show-on"
          options={MODES.map((option) => ({ id: option.id, label: lookCopy(option.key) }))}
          value={state.mode}
          onChange={state.choose}
        />
      </LookPanelBlock>
    ) : (
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        variant="selectable"
        search={false}
        selectedId={state.mode}
        showCategoryTitles={false}
        matchTriggerWidth
        connectToTrigger
        rowKind="item"
        itemTrigger={{ title, showSelectedSubtitle: false, itemProps: { testID: 'atmosphere-show-on' } }}
        items={MODES.map((option) => ({
          id: option.id,
          title: lookCopy(option.key),
          subtitle: option.id === 'everywhere' ? planetPlaces : undefined,
          testID: `atmosphere-show-on:${option.id}`,
        }))}
        onSelect={(id) => {
          state.choose(id as AtmosphereShowOnMode);
          setOpen(false);
        }}
      />
    );
  return <SettingAnchor setting={APPEARANCE_SETTINGS.settings.atmosphereShowOn}>{selector}</SettingAnchor>;
}

/** Look's compact control: the segments, and the places beneath them for Custom. */
export function AtmosphereShowOnPanel(props: Readonly<{ editor: AtmosphereEditor }>) {
  const state = useAtmosphereShowOn(props.editor);
  if (!state) return null;
  return (
    <>
      <AtmosphereShowOnSelector state={state} presentation="panel" />
      {state.mode === 'custom' ? <AtmospherePlacesField state={state} /> : null}
    </>
  );
}

/** Custom's places: one multi-select that commits once, when its menu closes. The Planet's rows say why they are off. */
export function AtmospherePlacesField(props: Readonly<{ state: AtmosphereShowOn }>) {
  const candidates = ATMOSPHERE_PLACES.map((place) => {
    const available = isAtmospherePlaceAvailable(place, props.state.source);
    return {
      id: place,
      title: lookCopy(PLACE_COPY[place]),
      disabled: !available,
      subtitle: available ? undefined : lookCopy('placePlanetOnly'),
    };
  });
  const shown = (ids: ReadonlySet<string>) =>
    candidates.filter(
      (candidate) => !candidate.disabled && ids.has(candidate.id),
    );
  return (
    <MultiSelectField
      testID="atmosphere-show-on-places"
      optionTestIDPrefix="atmosphere-show-on-place"
      title={lookCopy('showOnPlaces')}
      candidates={candidates}
      selectedIds={props.state.showOn}
      subtitle={(_count, _total, ids) => {
        const names = shown(ids).map((candidate) => candidate.title);
        return names.length ? names.join(', ') : lookCopy('showOnNowhere');
      }}
      emptySubtitle={lookCopy('showOnNowhere')}
      searchPlaceholder={lookCopy('showOnPlaces')}
      onCommit={(ids) =>
        props.state.commitPlaces(ATMOSPHERE_PLACES.filter((place) => ids.includes(place)))
      }
    />
  );
}
