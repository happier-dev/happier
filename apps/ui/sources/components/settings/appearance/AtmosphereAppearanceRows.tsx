import * as React from 'react';
import { isAtmosphereMomentOn } from '@/components/atmosphere/atmosphereMoments';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { useHomeAtmosphereEditor } from '@/components/atmosphere/look/atmosphereEditor';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { AtmospherePlacesField, AtmosphereShowOnSelector, useAtmosphereShowOn } from '@/components/atmosphere/look/AtmosphereShowOnControl';
import {
  PictureControls,
  PlanetControls,
  SourceControl,
  lookCopy,
} from '@/components/atmosphere/look/LookControls';
import { useAtmospherePictureCatalog } from '@/components/atmosphere/useAtmospherePictureCatalog';
import type { AtmosphereLookCopyKey } from '@/text/translations/glassAppearanceTranslations.shared';
import { t } from '@/text';
import { APPEARANCE_SETTINGS } from './appearanceSettings';

/** The backdrop half of "Glass and backdrop": the same controls as Home's Look panel, as page rows. */
export function AtmosphereAppearanceRows() {
  const editor = useHomeAtmosphereEditor();
  const pictures = useAtmospherePictureCatalog();
  return (
    <>
      <SourceControl editor={editor} presentation="page" pictures={pictures} />
      {editor.value.source === 'planet' ? (
        <PlanetControls editor={editor} presentation="page" />
      ) : editor.value.source === 'picture' ? (
        <PictureControls
          editor={editor}
          presentation="page"
          pictures={pictures}
        />
      ) : null}
    </>
  );
}

/** The moments the Home atmosphere declares (its default map), each with its title and description. */
const MOMENT_COPY = {
  welcome: ['momentWelcome', 'momentWelcomeNote'],
  loading: ['momentLoading', 'momentLoadingNote'],
  send: ['momentSend', 'momentSendNote'],
  qr: ['momentQr', 'momentQrNote'],
  pairing: ['momentPairing', 'momentPairingNote'],
  themeSwitch: ['momentThemeSwitch', 'momentThemeSwitchNote'],
  sessionFinished: ['momentSessionFinished', 'momentSessionFinishedNote'],
  idleResettle: ['momentIdleResettle', 'momentIdleResettleNote'],
  releaseCaption: ['momentReleaseCaption', 'momentReleaseCaptionNote'],
  yourHome: ['momentYourHome', 'momentYourHomeNote'],
} as const satisfies Record<string, readonly [AtmosphereLookCopyKey, AtmosphereLookCopyKey]>;
type MomentId = keyof typeof MOMENT_COPY;
const MOMENTS = Object.keys(MOMENT_COPY) as MomentId[];

/** How many of the atmosphere's moments are on, for the row that opens them. */
export function useAtmosphereMomentsSummary(): string {
  const value = useSetting('homeAtmosphere');
  const on = MOMENTS.filter((id) => isAtmosphereMomentOn(value.moments, id)).length;
  return t('settingsAppearance.momentsSummary', { on, total: MOMENTS.length });
}

/** Where the background shows: Everywhere, Home only, or the places picked (plan A3). */
export function AtmosphereWhereItShows() {
  const state = useAtmosphereShowOn(useHomeAtmosphereEditor());
  if (!state) return null;
  return (
    <ItemGroup
      title={lookCopy('whereItShows')}
      description={lookCopy('whereItShowsDescription')}
    >
      <AtmosphereShowOnSelector state={state} presentation="page" />
      {state.mode === 'custom' ? <AtmospherePlacesField state={state} /> : null}
    </ItemGroup>
  );
}

/** The per-moment switches. The page that hosts them says what moments are. */
export function AtmosphereMoments() {
  const { value, updateHome } = useHomeAtmosphereEditor();
  const momentOn = (id: MomentId) => isAtmosphereMomentOn(value.moments, id);
  const setMoment = (id: MomentId, on: boolean) =>
    updateHome((current) => ({
      ...current,
      moments: { ...current.moments, [id]: on },
    }));
  return (
    <ItemGroup>
      {MOMENTS.map((id, index) => {
        const row = (
          <Item
            key={id}
            testID={`atmosphere-moment:${id}`}
            title={lookCopy(MOMENT_COPY[id][0])}
            subtitle={lookCopy(MOMENT_COPY[id][1])}
            showChevron={false}
            onPress={() => setMoment(id, !momentOn(id))}
            rightElement={<Switch value={momentOn(id)} onValueChange={(on) => setMoment(id, on)} />}
          />
        );
        // Search reveals the moments at their first row.
        return index === 0 ? (
          <SettingAnchor key={id} setting={APPEARANCE_SETTINGS.settings.atmosphereMoments}>
            {row}
          </SettingAnchor>
        ) : row;
      })}
    </ItemGroup>
  );
}
