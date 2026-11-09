import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  WidgetAreaPresetResultV1Schema,
  WidgetSurfaceReadV1Schema,
  type WidgetAreaPresetStateV1,
  type WidgetAreaPresetUndoV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
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

/**
 * An edited preset's one quiet line (phone lab p5 "Usage", D23): "You changed this view." with a Reset
 * text button at its trailing edge. The canonical Action either awaits approval or applies the
 * recoverable reset. Only its applied result offers Undo, which restores exactly the layout it replaced.
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
      <Text style={styles.text} testID={`${props.testID}.text`}>
        {t('widgetFrame.presetChangedView')}
      </Text>
      <TextLinkButton
        testID={`${props.testID}.reset`}
        size="meta"
        label={t('common.reset')}
        accessibilityLabel={t('widgetFrame.presetReset')}
        disabled={busy}
        onPress={() => {
          void reset();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The line is its area's description: one meta line close under the heading, then a section's header gap
  // before the widgets (owner 11-08). Reset is words on the same line, so nothing is taller than the sentence.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s10,
    marginBottom: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
  },
  // The sentence takes the row; Reset holds the trailing edge.
  text: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
}));
