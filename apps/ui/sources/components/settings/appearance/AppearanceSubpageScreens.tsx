import * as React from 'react';
import {
  HAPPIER_SPINNER_PAUSE_IDS,
  HAPPIER_SPINNER_SPEED_IDS,
  HAPPIER_SPINNER_STYLE_IDS,
  happierSpinnerStyleTimingControls,
  isHappierSpinnerStyleId,
  normalizeHappierSpinnerStyleId,
  type HappierSpinnerPauseId,
  type HappierSpinnerSpeedId,
} from '@happier-dev/plugin-ui/presentation';

import { lookCopy } from '@/components/atmosphere/look/LookControls';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import {
  SettingAnchor,
  SettingRow,
} from '@/components/settings/shell/SettingRow';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  useLocalSettingMutable,
  useSettingMutable,
} from '@/sync/domains/state/storage';
import { t } from '@/text';

import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';

import { MachineSummaryAppearanceSection } from '@/components/machines/summary/MachineSummaryAppearanceSection';
import { useDeviceType } from '@/utils/platform/responsive';

import { APPEARANCE_SETTINGS } from './appearanceSettings';
import { AtmosphereMoments } from './AtmosphereAppearanceRows';
import {
  GlassAppearanceSection,
  useGlassAppearancePurpose,
} from './GlassAppearanceControls';
import {
  LOADING_INDICATOR_STYLE_LABEL_KEYS,
  LoadingIndicatorStylePreview,
} from './LoadingIndicatorStylePreview';
import {
  SurfaceFinishAppearanceSection,
  useSurfaceFinishLabel,
} from './SurfaceFinishAppearanceSection';
import {
  WidgetFrameAppearanceSection,
  useHomeWidgetFrameLabel,
} from './WidgetFrameAppearanceSection';

/*
 * The pages reached from Appearance. Each holds one family of rarely changed choices, so Appearance
 * itself stays the four decisions people make most. Their rows keep their Appearance anchors.
 */

const PAGE_LIST_STYLE = { paddingTop: 0 } as const;
const EFFECT_LEVELS = ['full', 'subtle', 'minimal'] as const;

/** Appearance › Glass and backdrop. */
export const GlassAppearanceScreen = React.memo(
  function GlassAppearanceScreen() {
    return (
      <ItemList testID="settings-appearance-glass" style={PAGE_LIST_STYLE}>
        <SettingsPageHeader description={useGlassAppearancePurpose()} />
        <GlassAppearanceSection />
      </ItemList>
    );
  },
);

/** Appearance › Moments. */
export const MomentsAppearanceScreen = React.memo(
  function MomentsAppearanceScreen() {
    return (
      <ItemList testID="settings-appearance-moments" style={PAGE_LIST_STYLE}>
        <SettingsPageHeader description={lookCopy('momentsDescription')} />
        <AtmosphereMoments />
      </ItemList>
    );
  },
);

/** Appearance › Widgets and surfaces. */
export const WidgetsAppearanceScreen = React.memo(
  function WidgetsAppearanceScreen() {
    return (
      <ItemList testID="settings-appearance-widgets" style={PAGE_LIST_STYLE}>
        <SettingsPageHeader
          description={t('settingsAppearance.widgetsAndSurfacesDescription')}
        />
        <WidgetFrameAppearanceSection />
        <SurfaceFinishAppearanceSection />
      </ItemList>
    );
  },
);

/** Appearance › Machine summary: a device-local look, so it sits with the other looks, not the Account's machine policies. */
export const MachineSummaryAppearanceScreen = React.memo(
  function MachineSummaryAppearanceScreen() {
    return (
      <ItemList testID="settings-appearance-machine-summary-page" style={PAGE_LIST_STYLE}>
        <SettingsPageHeader description={t('machineSummary.appearanceDescription')} />
        <MachineSummaryAppearanceSection phone={useDeviceType() === 'phone'} />
      </ItemList>
    );
  },
);

/** The widget frame on Home and the surface finish, for the row that opens the page. */
export function useWidgetsAppearanceSummary(): string {
  return `${useHomeWidgetFrameLabel()} · ${useSurfaceFinishLabel()}`;
}

/** The effects level and the loading indicator, for the row that opens the page. */
export function useMotionAppearanceSummary(): string {
  const [level] = useSettingMutable('visualEffectsLevel');
  const [style] = useLocalSettingMutable('loadingIndicatorStyle');
  return `${t(`settingsAppearance.visualEffects.levelOptions.${level}`)} · ${t(LOADING_INDICATOR_STYLE_LABEL_KEYS[normalizeHappierSpinnerStyleId(style)])}`;
}

/** Appearance › Motion: how much moves, then the loading indicator. */
export const MotionAppearanceScreen = React.memo(
  function MotionAppearanceScreen() {
    const [visualEffectsLevel, setVisualEffectsLevel] =
      useSettingMutable('visualEffectsLevel');
    const [animatedNumbers, setAnimatedNumbers] =
      useSettingMutable('animatedNumbers');
    const [hapticsEnabled, setHapticsEnabled] =
      useLocalSettingMutable('hapticsEnabled');
    const [loadingIndicatorStyle, setLoadingIndicatorStyle] =
      useLocalSettingMutable('loadingIndicatorStyle');
    const [loadingIndicatorSpeed, setLoadingIndicatorSpeed] =
      useLocalSettingMutable('loadingIndicatorSpeed');
    const [loadingIndicatorPause, setLoadingIndicatorPause] =
      useLocalSettingMutable('loadingIndicatorPause');
    const reduceMotion = useReducedMotionPreference();
    const settings = APPEARANCE_SETTINGS.settings;

    const levelChoices = React.useMemo(
      () =>
        EFFECT_LEVELS.map((id) => ({
          id,
          label: t(`settingsAppearance.visualEffects.levelOptions.${id}`),
        })),
      [],
    );
    const styleOptions = React.useMemo(
      () =>
        HAPPIER_SPINNER_STYLE_IDS.map((styleId) => ({
          id: styleId,
          title: t(LOADING_INDICATOR_STYLE_LABEL_KEYS[styleId]),
          preview: <LoadingIndicatorStylePreview styleId={styleId} />,
        })),
      [],
    );
    const speedChoices = React.useMemo(
      () =>
        HAPPIER_SPINNER_SPEED_IDS.map((id) => ({
          id,
          label: t(`settingsAppearance.loadingIndicatorSpeedOptions.${id}`),
        })),
      [],
    );
    const pauseChoices = React.useMemo(
      () =>
        HAPPIER_SPINNER_PAUSE_IDS.map((id) => ({
          id,
          label: t(`settingsAppearance.loadingIndicatorPauseOptions.${id}`),
        })),
      [],
    );

    const displayStyle = normalizeHappierSpinnerStyleId(loadingIndicatorStyle);
    // A timing choice the chosen style ignores stays visible but disabled, and says why once: the
    // Classic Ring's note on Speed also covers the Pause row beneath it.
    const timing = happierSpinnerStyleTimingControls(displayStyle);

    return (
      <ItemList testID="settings-appearance-motion" style={PAGE_LIST_STYLE}>
        <SettingsPageHeader
          description={
            reduceMotion
              ? t('settingsAppearance.visualEffects.reduceMotionActive')
              : t('settingsAppearance.visualEffects.footer')
          }
        />
        <ItemGroup>
          <SettingAnchor setting={settings.visualEffectsLevel}>
          <SegmentedChoiceItem
            title={t('settingsAppearance.visualEffects.level')}
            subtitle={t('settingsAppearance.visualEffects.levelDescription')}
            subtitleLines={0}
            testID="settings-appearance-visualEffectsLevel-select"
            testIDPrefix="settings-appearance-visualEffectsLevel"
            options={levelChoices}
            value={visualEffectsLevel}
            onChange={setVisualEffectsLevel}
          />
          </SettingAnchor>
          <SettingAnchor setting={settings.animatedNumbers}>
          <Item
            title={t('settingsAppearance.visualEffects.animatedNumbers')}
            subtitle={t(
              'settingsAppearance.visualEffects.animatedNumbersDescription',
            )}
            subtitleLines={0}
            rightElement={
              <Switch
                testID="settings-appearance-animatedNumbers-switch"
                value={animatedNumbers}
                onValueChange={setAnimatedNumbers}
              />
            }
            showChevron={false}
          />
          </SettingAnchor>
        </ItemGroup>

        {settingRendersOnHost(settings.haptics) && (
          <ItemGroup title={t('settingsAppearance.feedback')}>
            <SettingRow
              setting={settings.haptics}
              subtitleLines={0}
              rightElement={
                <Switch
                  testID="settings-appearance-haptics-switch"
                  value={hapticsEnabled}
                  onValueChange={setHapticsEnabled}
                />
              }
              showChevron={false}
            />
          </ItemGroup>
        )}

        <ItemGroup
          title={t('settingsAppearance.loadingIndicator')}
          description={t('settingsAppearance.loadingIndicatorFooter')}
        >
          <SettingRow
            setting={settings.loadingIndicatorStyle}
            accessoryLayout="stacked"
            rightElement={
              <SelectionTiles
                variant="visual"
                accessibilityLabel={t(settings.loadingIndicatorStyle.titleKey)}
                testIdPrefix="settings-appearance-loadingIndicator"
                value={displayStyle}
                options={styleOptions}
                onChange={(next) => {
                  if (isHappierSpinnerStyleId(next))
                    setLoadingIndicatorStyle(next);
                }}
              />
            }
            showChevron={false}
          />
          <SettingAnchor setting={settings.loadingIndicatorSpeed}>
            <SegmentedChoiceItem<HappierSpinnerSpeedId>
              title={t(settings.loadingIndicatorSpeed.titleKey)}
              subtitle={
                timing.speed
                  ? t('settingsAppearance.loadingIndicatorSpeedDescription')
                  : t('settingsAppearance.loadingIndicatorSpeedUnavailable')
              }
              subtitleLines={0}
              testIDPrefix="settings-appearance-loadingIndicatorSpeed"
              options={speedChoices}
              value={loadingIndicatorSpeed}
              onChange={setLoadingIndicatorSpeed}
              disabled={!timing.speed}
            />
          </SettingAnchor>
          <SettingAnchor setting={settings.loadingIndicatorPause}>
            <SegmentedChoiceItem<HappierSpinnerPauseId>
              title={t(settings.loadingIndicatorPause.titleKey)}
              subtitle={
                timing.pause || !timing.speed
                  ? t('settingsAppearance.loadingIndicatorPauseDescription')
                  : t('settingsAppearance.loadingIndicatorPauseUnavailable')
              }
              subtitleLines={0}
              testIDPrefix="settings-appearance-loadingIndicatorPause"
              options={pauseChoices}
              value={loadingIndicatorPause}
              onChange={setLoadingIndicatorPause}
              disabled={!timing.pause}
            />
          </SettingAnchor>
        </ItemGroup>
      </ItemList>
    );
  },
);
