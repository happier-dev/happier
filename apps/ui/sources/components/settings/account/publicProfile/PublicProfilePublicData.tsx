import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type {
  PublicProfileField,
  PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { PublicProfilePanelHeader } from './PublicProfilePanelHeader';
import type { PublicFieldPlacement } from './publicProfileDraft';

/** Reading order of the one leaf-policy panel; every switch edits exactly one consent item. */
const SECTIONS = [
  ['about', ['name', 'avatar', 'since', 'bio', 'links']],
  [
    'numbers',
    [
      'tokens',
      'activeDays',
      'agentTime',
      'mergedPrs',
      'currentStreak',
      'bestStreak',
      'peakParallel',
      'highlights',
    ],
  ],
  ['patterns', ['calendar', 'punch', 'agentMix', 'sourceSplit']],
  [
    'detail',
    [
      'agentActiveDays',
      'weeklyAgentMix',
      'weeklyPeakParallel',
      'sessionDurations',
      'machineKinds',
      'dayNightActivity',
    ],
  ],
  ['links', ['projects', 'footprint']],
] as const satisfies readonly (readonly [
  string,
  readonly PublicProfileField[],
])[];

const DETAILS: Partial<
  Record<
    PublicProfileField,
    | 'calendar'
    | 'punch'
    | 'weeklyAgentMix'
    | 'sessionDurations'
    | 'machineKinds'
    | 'dayNightActivity'
    | 'projects'
    | 'footprint'
  >
> = {
  calendar: 'calendar',
  punch: 'punch',
  weeklyAgentMix: 'weeklyAgentMix',
  sessionDurations: 'sessionDurations',
  machineKinds: 'machineKinds',
  dayNightActivity: 'dayNightActivity',
  projects: 'projects',
  footprint: 'footprint',
};

function placementLine(
  placement: PublicFieldPlacement | undefined,
): string | null {
  if (!placement) return null;
  if (placement.shown && placement.heading) return t('publicIdentity.publicData.heading');
  if (placement.shown)
    return placement.blocks > 0
      ? t('publicIdentity.publicData.blocks', { count: placement.blocks })
      : t('publicIdentity.publicData.notPlaced');
  return placement.blocks > 0
    ? t('publicIdentity.publicData.placedPrivate')
    : t('publicIdentity.publicData.notShared');
}

/**
 * Public data (lab `pppriv-PD`): the only place consent changes. Blocks decide where things appear;
 * these items decide what leaves the device, for the page, badges, card and JSON alike.
 */
export function PublicProfilePublicData(
  props: Readonly<{
    policy: PublicProfilePolicyV1;
    /** Null while the page has no local preview yet; the switches still work. */
    placements: Readonly<
      Record<PublicProfileField, PublicFieldPlacement>
    > | null;
    onToggle: (field: PublicProfileField, shown: boolean) => void;
    disabled?: boolean;
    /** The latest published consent change, beside the switches that made it. */
    status?: React.ReactNode;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <>
      <PublicProfilePanelHeader title={t('publicIdentity.publicData.title')} description={t('publicIdentity.publicData.description')} />
      {props.status}
      {SECTIONS.map(([section, fields]) => (
        <ItemGroup
          key={section}
          title={t(`publicIdentity.publicData.sections.${section}`)}
        >
          {fields.map((field) => {
            const shown = props.policy.fields[field];
            // The weekly maximum is the period peak, so weekly peaks need Peak parallel shared first.
            const blocked =
              field === 'weeklyPeakParallel' &&
              !props.policy.fields.peakParallel;
            const detail = blocked
              ? t('publicIdentity.publicData.needsPeak')
              : DETAILS[field]
                ? t(`publicIdentity.publicData.details.${DETAILS[field]}`)
                : null;
            const placement = placementLine(props.placements?.[field]);
            return (
              <Item
                key={field}
                testID={`public-data-row-${field}`}
                title={t(`publicIdentity.publicData.fields.${field}`)}
                subtitle={
                  [placement, detail].filter(Boolean).join(' · ') || undefined
                }
                subtitleLines={0}
                showChevron={false}
                rightElement={
                  <Switch
                    testID={`public-data-switch-${field}`}
                    accessibilityLabel={t(
                      `publicIdentity.publicData.fields.${field}`,
                    )}
                    value={shown && !blocked}
                    disabled={props.disabled || blocked}
                    onValueChange={(value) => props.onToggle(field, value)}
                    trackColor={{
                      false: theme.colors.switch.track.inactive,
                      true: theme.colors.switch.track.active,
                    }}
                    thumbColor={
                      shown && !blocked
                        ? theme.colors.switch.thumb.active
                        : theme.colors.switch.thumb.inactive
                    }
                  />
                }
              />
            );
          })}
        </ItemGroup>
      ))}
    </>
  );
}
