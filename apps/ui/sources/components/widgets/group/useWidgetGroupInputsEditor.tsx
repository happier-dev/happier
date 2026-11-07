import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  WidgetInputBindingsV1,
  WidgetLayoutGroupV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetSetupPopover } from '@/components/widgets/add/WidgetSetupPopover';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import {
  buildWidgetCandidateSetup,
  runWidgetSetupCommand,
  widgetDefinitionOfCandidate,
  type WidgetSurfaceContext,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import { resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useWidgetBindingValueLabels, type WidgetBindingValueLabels } from '@/components/widgets/surface/useWidgetBindingValueLabels';
import { t } from '@/text';

import {
  buildWidgetGroupInputsCandidate,
  describeWidgetGroupInputsBinding,
} from './widgetGroupInputs';
import { WIDGET_GROUP_ICON } from './widgetGroupMenu';

const NO_FIELDS: readonly never[] = [];

/**
 * A group's Inputs… (lab wginputs I): the A4 Set up step — the same header, field rows, value
 * buttons, options owner and footer — over the inputs the group's widgets declare. Below the
 * fields, who follows the group and who keeps its own value; the footer line says the group grants
 * nothing. Saving is the group's one inputs intent; the widgets themselves are not rewritten.
 */
export function useWidgetGroupInputsEditor(
  input: Readonly<{
    group: WidgetLayoutGroupV1;
    candidates: readonly (WidgetCandidate | null)[];
    title: string;
    scope: WidgetSurfaceRefV1 | null;
    context: WidgetSurfaceContext;
    /** The surface's group inputs write; absent where this viewer cannot change the group. */
    setInputs?:
      | ((bindings: WidgetInputBindingsV1) => Promise<WidgetSetupSubmitResult>)
      | undefined;
    childTitle?: (instanceId: string) => string;
    testID: string;
  }>,
): Readonly<{
  anchorRef: React.RefObject<View | null>;
  editInputs:
    | Readonly<{ onPress: () => void; binding: string | null }>
    | undefined;
  popover: React.ReactElement | null;
  labels: WidgetBindingValueLabels;
}> {
  const anchorRef = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<Readonly<{ callerContext: ActionExecutorContext | undefined }> | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { group, scope, context, setInputs, testID } = input;
  // Built once when the step opens (the popover keeps its first setup); cheap to derive per render.
  const candidate = React.useMemo(() => buildWidgetGroupInputsCandidate({ title: input.title, candidates: input.candidates }), [input.title, input.candidates]);
  const editable = candidate !== null && scope !== null && setInputs !== undefined;
  const commands = useCurrentUiContextLocalCommands(editable ? [
    { key: 'open', title: t('widgetFrame.groupInputsTitle', { group: input.title }), description: `${testID}.groupInputs.open`,
      invoke: (_value, callerContext) => { setNotice(null); setOpen({ callerContext }); } },
    ...(open ? [{ key: 'close', title: `${t('common.close')}: ${input.title}`, description: `${testID}.groupInputs.close`,
      invoke: () => setOpen(null) }] : []),
  ] : [], { contextKey: `${testID}.groupInputs`, unbound: 'local' });
  const show = React.useCallback(() => { void commands.invoke('open'); }, [commands]);
  const close = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
  const done = React.useCallback((result: Extract<WidgetSetupSubmitResult, { ok: true }>) => {
    if (result.approvalPending) setNotice(t('widgetAdd.areaApprovalPending'));
    else close();
  }, [close]);
  const labels = useWidgetBindingValueLabels(group.context ?? {}, candidate, input.candidates);
  // The Inputs… row names what is bound before its value (lab wgmenu M "Project: happier").
  const binding = describeWidgetGroupInputsBinding(group.context, labels, candidate?.inputs?.fields ?? NO_FIELDS);
  const editInputs = React.useMemo(
    () => (editable ? { onPress: show, binding } : undefined),
    [binding, editable, show],
  );
  const childTitle = input.childTitle;
  const buildSetup = React.useCallback(() => {
    const setup = buildWidgetCandidateSetup({
      candidate: candidate!,
      fieldCandidates: input.candidates,
      context,
      audience: 'personal',
      mode: {
        kind: 'edit',
        instance: {
          v: 1,
          id: group.id,
          definition: widgetDefinitionOfCandidate(candidate!),
          bindings: group.context ?? {},
        },
      },
      scope,
      submit: (draft): Promise<WidgetSetupSubmitResult> =>
        runWidgetSetupCommand(
          () => { setNotice(null); return setInputs!(draft.bindings); },
          t('widgetAdd.saveFailed'),
        ),
    });
    return {
      ...setup,
      title: t('widgetFrame.groupInputsTitle', { group: input.title }),
      hint: t('widgetFrame.groupInputsHint'),
      widget: { title: input.title, mark: WIDGET_GROUP_ICON },
      renderPreview: () => (
        <WidgetGroupFollowers
          group={group}
          candidates={input.candidates}
          childTitle={childTitle}
          testID={`${testID}.groupInputs.followers`}
        />
      ),
    };
  }, [
    candidate,
    childTitle,
    context,
    group,
    input.title,
    input.candidates,
    scope,
    setInputs,
    testID,
  ]);
  const popover =
    editable && open ? (
      <WidgetSetupPopover
        open
        callerContext={open.callerContext}
        anchorRef={anchorRef}
        setup={buildSetup}
        onRequestClose={close}
        onDone={done}
        notice={notice}
        serverId={scope!.serverId}
        testID={`${testID}.groupInputs`}
      />
    ) : null;
  return { anchorRef, editInputs, popover, labels };
}

/** Who follows the group and who keeps its own value, then the boundary: the group grants nothing. */
function WidgetGroupFollowers(
  props: Readonly<{
    group: WidgetLayoutGroupV1;
    candidates: readonly (WidgetCandidate | null)[];
    childTitle?: ((instanceId: string) => string) | undefined;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const slots = new Set(Object.keys(props.group.context ?? {}));
  const rows = props.group.children.map((child) => {
    const follows = Object.values(child.instance.bindings).some(
      (binding) => binding.kind === 'context' && slots.has(binding.slot),
    );
    return {
      id: child.instance.id,
      title:
        props.childTitle?.(child.instance.id) ??
        resolveWidgetInstanceTitle(child.instance, props.candidates.find(candidate => candidate
          && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), child.instance.definition))),
      follows,
    };
  });
  const following = rows.filter((row) => row.follows).length;
  return (
    <View testID={props.testID} style={styles.list}>
      <Text style={styles.heading}>
        {t('widgetFrame.groupFollowCount', { following, count: rows.length })}
      </Text>
      {rows.map((row) => (
        <View key={row.id} style={styles.row}>
          <Text style={styles.title} numberOfLines={1}>
            {row.title}
          </Text>
          <Icon
            name={row.follows ? 'link' : 'push-pin'}
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
          <Text style={styles.meta} numberOfLines={1}>
            {t(
              row.follows
                ? 'widgetFrame.groupFollows'
                : 'widgetFrame.groupOwnValue',
            )}
          </Text>
        </View>
      ))}
      <Text style={styles.boundary}>{t('widgetFrame.groupGrantsNothing')}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.space.s8 },
  heading: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minHeight: 28 },
  title: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flex: 1,
    minWidth: 0,
  },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  boundary: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
}));
