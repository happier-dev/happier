import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1,
  type PublicProfileLayoutPresetIdV1,
} from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';

import {
  readUsageWidgetPageContext,
  readUsageWidgetPageScope,
  readUsageWidgetQueryOverrides,
  usageWidgetSurfaceContext,
} from '@/components/settings/usage/usageWidgetPageContext';
import { UsageWidgetBatchProvider } from '@/components/settings/usage/widgets/usageWidgetBatch';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutLabels,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { useCorePageWidgetAreaLayoutBar } from '@/components/widgets/area/useCorePageWidgetAreaLayoutBar';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import type { usePublicProfileWidgetArea } from './usePublicProfileWidgetArea';

const PRESET_NAME_KEYS = {
  minimal: 'publicIdentity.editor.presetMinimal',
  dataRich: 'publicIdentity.editor.presetDataRich',
  story: 'publicIdentity.editor.presetStory',
  nightOwl: 'publicIdentity.editor.presetNightOwl',
} as const satisfies Record<PublicProfileLayoutPresetIdV1, string>;

export function publicProfilePresetNames(): Readonly<
  Record<PublicProfileLayoutPresetIdV1, string>
> {
  return Object.fromEntries(
    PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map((id) => [
      id,
      t(PRESET_NAME_KEYS[id]),
    ]),
  ) as Record<PublicProfileLayoutPresetIdV1, string>;
}

/**
 * The owner's widgets read their own Usage for the page's public period, exactly as the Usage page
 * reads it: "This page" is that period with no filters.
 */
export function usePublicProfileUsageContext(period: UsagePeriod): Readonly<{
  context: WidgetSurfaceContext;
  clauses: ReturnType<typeof readUsageWidgetQueryOverrides>;
}> {
  return React.useMemo(() => {
    const query = normalizeUsageQuery({ period: { relative: period } });
    return {
      context: usageWidgetSurfaceContext(
        readUsageWidgetPageContext(readUsageWidgetPageScope(query)),
        period,
      ),
      clauses: readUsageWidgetQueryOverrides(query),
    };
  }, [period]);
}

/** The same words every area uses for its named layouts (Usage's views, a plugin page's layouts). */
const LAYOUT_LABELS: WidgetAreaLayoutLabels = {
  get list() { return t('publicIdentity.editor.layouts'); },
  current: (name) => name,
  get create() { return t('usage.board.page.newView'); },
  get createEllipsis() { return t('usage.board.page.newView'); },
  actions: (name) => t('usage.board.page.viewActions', { name }),
  get rename() { return t('usage.board.page.renameView'); },
  moveBefore: (name) => t('usage.board.page.moveViewBefore', { name }),
  moveAfter: (name) => t('usage.board.page.moveViewAfter', { name }),
  get delete() { return t('usage.board.page.deleteView'); },
  get deleteLabel() { return t('usage.board.page.deleteView'); },
};

/**
 * Edit on the owner's page (lab `ppcomp-E`, `pplay-L`): the one widget-area owner in place of the
 * projected blocks. Its named layouts are the area's own: the presets (Minimal, Data-rich, Story,
 * Night owl) and any the owner creates, renames, reorders or deletes, through the same layout bar
 * Usage and plugin pages draw. Switching or editing a layout writes only the private Account area;
 * nothing here is public until it is compiled at a reviewed Apply.
 */
export function PublicProfileWidgetArea(
  props: Readonly<{
    widgetArea: ReturnType<typeof usePublicProfileWidgetArea>;
    clauses: ReturnType<typeof readUsageWidgetQueryOverrides>;
  }>,
): React.ReactElement {
  const { binding, area } = props.widgetArea;
  const ready = area.state.status === 'ready' ? area.state : null;
  const names = React.useMemo(publicProfilePresetNames, []);
  const presets = React.useMemo(() => PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map((id) => ({ id, name: names[id] })), [names]);
  const bar = useCorePageWidgetAreaLayoutBar({ binding, area, presets, newLayoutBody: t('publicIdentity.editor.newLayoutBody') });
  const title = bar.selectedName ?? t('publicIdentity.editor.blocksTitle');
  return (
    <UsageWidgetBatchProvider clauses={props.clauses}>
      <View style={styles.area} testID="public-profile-area-editor">
        <WidgetAreaLayoutBar
          layouts={bar.layouts}
          selectedId={bar.selectedId}
          onSelect={bar.onSelect}
          onCreate={bar.onCreate}
          actions={bar.actions}
          readFailure={bar.readFailure}
          labels={LAYOUT_LABELS}
          heading="section"
          testID="public-profile-area-layouts"
        />
        {ready?.preset?.isEdited ? (
          <WidgetAreaPresetLine
            preset={ready.preset}
            surface={ready.surface}
            presetActions={binding}
            testID="public-profile-area.preset"
          />
        ) : null}
        <WidgetArea
          port={binding.port}
          context={binding.context}
          layout={area}
          geometry="grid"
          title={title}
          surfaceName={title}
          dashboard={{
            addLabel: t('publicIdentity.editor.addBlock'),
            emptyTitle: t('publicIdentity.page.empty'),
            addTitle: t('publicIdentity.editor.addBlockTitle'),
          }}
          testID="public-profile-area"
        />
      </View>
    </UsageWidgetBatchProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  area: { gap: theme.space.s12 },
}));
