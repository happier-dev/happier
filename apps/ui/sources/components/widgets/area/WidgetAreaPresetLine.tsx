import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  WidgetAreaPresetResultV1Schema,
  WidgetSurfaceReadV1Schema,
  type WidgetAreaPresetChangeV1,
  type WidgetAreaPresetStateV1,
  type WidgetInstanceV1,
  type WidgetAreaPresetUndoV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { readWidgetDescriptor, resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The canonical preset Actions, through the app's executor; the area re-reads on the Artifact's publication. */
async function runPresetAction(
  actionId: 'widgets.item.list' | 'widgets.area.layout.reset' | 'widgets.area.layout.undo',
  input: unknown,
  surface: WidgetSurfaceRefV1,
) {
  const { createDefaultActionExecutor } =
    await import('@/sync/ops/actions/defaultActionExecutor');
  return createDefaultActionExecutor().execute(actionId, input, {
    surface: 'ui',
    serverId: surface.serverId,
    expectedAccountId: surface.accountId,
  });
}

/** The line names this many changes; the rest are counted ("and made 2 more changes"). */
const NAMED_CHANGES = 2;

/** The widgets a change's item is named by: itself, or a group's children. */
function changeInstances(change: WidgetAreaPresetChangeV1): readonly WidgetInstanceV1[] {
  if (change.kind === 'renamed') return [];
  return change.item.kind === 'widget' ? [change.item.instance] : change.item.children.map(child => child.instance);
}

/**
 * What the edit changed, in words (lab wgsaved R: "you moved Limits up and removed Active days"),
 * from the layout owner's own comparison (`preset.changes`). Widgets are named as their cards are:
 * the copy's own name, else the widget it is; a group by its title, else its widgets.
 */
function usePresetChangeSummary(changes: readonly WidgetAreaPresetChangeV1[], surface: WidgetSurfaceRefV1): string | null {
  const runtime = useAppShellPluginUiProjection();
  const named = React.useMemo(() => changes.slice(0, NAMED_CHANGES), [changes]);
  const instances = React.useMemo(() => named.flatMap(changeInstances), [named]);
  const installed = React.useMemo(() => instances.flatMap(instance => {
    const candidate = readWidgetDescriptor(runtime.pluginUiProjection, instance.definition);
    return candidate ? [candidate] : [];
  }), [instances, runtime.pluginUiProjection]);
  const descriptors = useWidgetInstanceDescriptors(surface, instances, installed);
  return React.useMemo(() => {
    const title = (instance: WidgetInstanceV1) => resolveWidgetInstanceTitle(instance, descriptors[instances.indexOf(instance)]);
    const phrases = named.map(change => {
      if (change.kind === 'renamed') return t('widgetFrame.presetRenamed');
      const item = change.item.kind === 'widget' ? title(change.item.instance)
        : change.item.title ?? change.item.children.map(child => title(child.instance)).join(' · ');
      return change.kind === 'moved' ? t(change.direction === 'up' ? 'widgetFrame.presetMovedUp' : 'widgetFrame.presetMovedDown', { item })
        : t(change.kind === 'added' ? 'widgetFrame.presetAdded' : change.kind === 'removed' ? 'widgetFrame.presetRemoved' : 'widgetFrame.presetChanged', { item });
    });
    return phrases[0] ? t('widgetFrame.presetChangeList', { first: phrases[0], second: phrases[1] ?? null, more: changes.length - phrases.length }) : null;
  }, [changes.length, descriptors, instances, named]);
}

/**
 * An edited preset's one line (lab wgsaved R): "Overview is yours now: you moved Limits up and removed
 * Active days. The preset is kept." with Reset to preset at its trailing edge. The canonical Action
 * either awaits approval or applies the recoverable reset. Only its applied result offers Undo,
 * which restores exactly the layout it replaced.
 */
export function WidgetAreaPresetLine(
  props: Readonly<{
    preset: WidgetAreaPresetStateV1;
    surface: WidgetSurfaceRefV1;
    testID: string;
    /** Core pages supply their captured preset resolver and Account lifetime. */
    presetActions?: Readonly<{
      resetPreset(target?: WidgetSurfaceRefV1): Promise<ActionExecuteResult>;
      undoReset(capture: WidgetAreaPresetUndoV1): Promise<ActionExecuteResult>;
    }>;
  }>,
) {
  const [busy, setBusy] = React.useState(false);
  const { preset, surface } = props;
  const { theme } = useUnistyles();
  const summary = usePresetChangeSummary(preset.changes, surface);
  const reset = React.useCallback(async () => {
    setBusy(true);
    const failure = () => publishPresentationNotice({ key: `widget-area-preset:${preset.id}`, severity: 'error', message: t('widgetFrame.presetResetFailed') });
    try {
      // Project surfaces use the executor's implicit Project presets; core pages
      // must use their bound metadata rather than create another preset registry.
      const resetUnbound = async () => {
        const read = await runPresetAction('widgets.item.list', { surface }, surface);
        const state = read.ok ? WidgetSurfaceReadV1Schema.safeParse(read.result) : null;
        if (!state?.success) return read;
        return runPresetAction('widgets.area.layout.reset',
          { surface, expectedRevision: state.data.revision ?? null }, surface);
      };
      const result = await (props.presetActions ? props.presetActions.resetPreset(surface) : resetUnbound());
      const pending = (result: ActionExecuteResult) => {
        if (!result.ok || !ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return false;
        publishPresentationNotice({ key: `widget-area-preset:${preset.id}`, severity: 'info', message: t('widgetAdd.areaApprovalPending') });
        return true;
      };
      if (pending(result)) return;
      const parsed = result.ok ? WidgetAreaPresetResultV1Schema.safeParse(result.result) : null;
      if (!parsed?.success) {
        failure();
        return;
      }
      const capture = parsed.data.undo;
      publishPresentationNotice({
        key: `widget-area-preset:${preset.id}`,
        severity: 'info',
        message: t('widgetFrame.presetResetDone', { name: preset.name }),
        ...(capture ? {
          undo: {
            label: t('widgetFrame.undo'),
            run: () => {
              const undo = props.presetActions ? props.presetActions.undoReset(capture)
                : runPresetAction('widgets.area.layout.undo', { capture }, surface);
              void undo.then(result => { if (!pending(result) && !result.ok) failure(); }, failure);
            },
          },
        } : {}),
      });
    } catch {
      failure();
    } finally {
      setBusy(false);
    }
  }, [preset.id, preset.name, props.presetActions, surface]);
  return (
    <View testID={props.testID} style={styles.line}>
      <Icon name="arrow-arc-left" size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
      <Text style={styles.text} testID={`${props.testID}.text`}>
        <Text style={styles.name}>{preset.name}</Text>
        {t('widgetFrame.presetEditedTail', { changes: summary })}
      </Text>
      <RoundButton
        testID={`${props.testID}.reset`}
        size="small"
        display="secondary"
        title={t('widgetFrame.presetReset')}
        disabled={busy}
        onPress={() => {
          void reset();
        }}
      />
    </View>
  );
}

/** Reset is taller than the sentence; the line gives that slack back above it, so the sentence sits under its heading. */
const PRESET_LINE_BUTTON_SLACK_PX = (HAPPIER_PAGE_METRICS.smallControlHeightPx - happierPageTextMetrics('meta').lineHeight) / 2;

const styles = StyleSheet.create((theme) => ({
  // The line is its area's description: close under the heading, then a section's header gap before the widgets
  // (owner 11-08: the space sat between the heading and the line, with none between the line and the widgets).
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s10,
    marginTop: -PRESET_LINE_BUTTON_SLACK_PX,
    marginBottom: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
  },
  // The sentence takes the row; Reset stays at the trailing edge and drops under it only on a phone.
  text: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
    minWidth: 0,
  },
  name: {
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
}));
