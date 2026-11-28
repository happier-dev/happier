import * as React from 'react';
import type { InputFieldHint } from '@happier-dev/protocol/inputs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  WidgetInputBindingsV1,
  WidgetLayoutGroupV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { isSameWidgetDefinitionV1, WidgetBindingResolutionV1Schema, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetSetupPopover } from '@/components/widgets/add/WidgetSetupPopover';
import type { WidgetSetup, WidgetSetupInheritedReading, WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import {
  buildWidgetCandidateSetup,
  runWidgetSetupCommand,
  widgetDefinitionOfCandidate,
  type WidgetSurfaceContext,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import { resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useWidgetBindingValueLabels } from '@/components/widgets/surface/useWidgetBindingValueLabels';
import { readWidgetBindingFieldTitle, summarizeWidgetBindingReadings } from '@/components/widgets/surface/widgetBindingValueLabel';
import { t } from '@/text';

import {
  buildWidgetGroupInputsCandidate,
  describeWidgetGroupInputsBinding,
} from './widgetGroupInputs';
import { createWidgetGroupFollowedInputReader, readWidgetGroupInputFollowers, type WidgetGroupFollowedInputReading, type WidgetGroupInputReadings } from './widgetGroupFollowedInputs';
import { WIDGET_GROUP_ICON } from './widgetGroupMenu';
import type { WidgetGroupChildInputRepairContext } from './WidgetGroupChildInputRepairContext';

const NO_FIELDS: readonly never[] = [];
const NO_BINDINGS: WidgetInputBindingsV1 = Object.freeze({});

type RefusedChildInput = Readonly<{ childId: string; fieldPath: string | undefined }>;

function readRefusedChildInput(details: unknown): RefusedChildInput | null {
  if (!details || typeof details !== 'object' || !('blockingChildId' in details)) return null;
  const { blockingChildId, blockingFieldPath, ...resolution } = details as Record<string, unknown>;
  if (typeof blockingChildId !== 'string') return null;
  const result = WidgetBindingResolutionV1Schema.safeParse(resolution);
  if (!result.success || result.data.status === 'ready') return null;
  return { childId: blockingChildId, fieldPath: typeof blockingFieldPath === 'string' ? blockingFieldPath : undefined };
}

/** The opening page is fixed. Each draft uses the same composed inputs the following children read. */
function createGroupInheritedReader(
  group: WidgetLayoutGroupV1,
  candidates: readonly (WidgetCandidate | null)[],
  surfaceOwner: WidgetSurfaceRefV1['owner'] | undefined,
  context: WidgetSurfaceContext,
  readings: WidgetGroupInputReadings,
  fields: readonly InputFieldHint[],
  labelledBindings: WidgetInputBindingsV1 | undefined,
): NonNullable<WidgetSetup['readInherited']> {
  const children = group.children.flatMap(({ instance }, index) => {
    const descriptor = candidates[index];
    if (!descriptor) return [];
    const followers = readings.byChild.get(instance.id);
    return followers?.length ? [{ instance, descriptor, followers }] : [];
  });

  const declaredSlots = children.flatMap(({ followers }) => followers);
  const fieldTitles = new Map(fields.map(({ path }) => [path,
    readWidgetBindingFieldTitle(path, declaredSlots.filter(({ field }) => field.path === path))]));
  return bindings => {
    const readChild = createWidgetGroupFollowedInputReader({
      context, surfaceOwner, bindings, labelledBindings, labels: readings.labels, fields: declaredSlots,
    });
    const values = new Map<string, { slot: string; reading: WidgetGroupFollowedInputReading | null }[]>();
    for (const { instance, descriptor, followers } of children) {
      const unset = followers.filter(({ field }) => bindings[field.path] === undefined);
      if (!unset.length) continue;
      const read = readChild(instance, descriptor);
      for (const follower of unset) {
        const { path } = follower.field;
        const reading = { slot: follower.slot, reading: read(follower) };
        const matching = values.get(path);
        if (matching) matching.push(reading);
        else values.set(path, [reading]);
      }
    }

    const inherited = new Map<string, WidgetSetupInheritedReading>();
    for (const field of fields) {
      const matching = values.get(field.path);
      if (!matching) continue;
      const result = summarizeWidgetBindingReadings(matching.map(({ reading }) => reading));
      const first = matching[0]!;
      const source = first.reading?.source;
      const attribution = source !== undefined && matching.every(({ reading }) => reading?.source === source)
        ? { source } : {};
      if (result?.kind === 'several') {
        inherited.set(field.path, { ...result, ...attribution });
        continue;
      }
      const { slot } = first;
      // Only a common, resolved slot with no group override can be the field's implicit page binding.
      const pageSlot = bindings[slot] === undefined && matching.every(candidate =>
        candidate.slot === slot && candidate.reading !== null) ? slot : undefined;
      inherited.set(field.path, {
        kind: 'single',
        valueLabel: result?.label ?? fieldTitles.get(field.path)!,
        ...attribution,
        ...(pageSlot === undefined ? {} : { pageSlot }),
      });
    }
    return inherited;
  };
}

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
  readings: WidgetGroupInputReadings;
  childRepair: React.ContextType<typeof WidgetGroupChildInputRepairContext>;
}> {
  const anchorRef = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState<Readonly<{
    callerContext: ActionExecutorContext | undefined;
    context: WidgetSurfaceContext;
    group: WidgetLayoutGroupV1;
    candidates: readonly (WidgetCandidate | null)[];
    fields: readonly InputFieldHint[];
    byChild: WidgetGroupInputReadings['byChild'];
  }> | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [repairTarget, setRepairTarget] = React.useState<RefusedChildInput | null>(null);
  const { group, scope, context, setInputs, testID } = input;
  // Each child declares its followers once. The label owner, preview, and card share this result.
  const byChild = React.useMemo(() => new Map(group.children.map(({ instance }, index) => {
    const descriptor = input.candidates[index];
    return [instance.id, descriptor ? readWidgetGroupInputFollowers(instance, descriptor) : NO_FIELDS] as const;
  })), [group.children, input.candidates]);
  const fields = React.useMemo(() => [...byChild.values()].flat(), [byChild]);
  const labels = useWidgetBindingValueLabels(group.context ?? NO_BINDINGS, null, fields);
  // The popover keeps the setup it opened with.
  const candidate = React.useMemo(() => {
    const descriptor = buildWidgetGroupInputsCandidate({ title: input.title, candidates: input.candidates });
    if (!descriptor?.inputs) return descriptor;
    // A group edit sets overrides. Each child still validates its own effective inputs.
    const fields = descriptor.inputs.fields.map(({ required: _required, requiredWhen: _requiredWhen, ...field }) => field);
    return { ...descriptor, inputs: { ...descriptor.inputs, fields } };
  }, [input.title, input.candidates]);
  const readings = React.useMemo(() => ({ fields, byChild, labels }), [fields, byChild, labels]);
  const editable = candidate !== null && scope !== null && setInputs !== undefined;
  const commands = useCurrentUiContextLocalCommands(editable ? [
    { key: 'open', title: t('widgetFrame.groupInputsTitle', { group: input.title }), description: `${testID}.groupInputs.open`,
      invoke: (_value, callerContext) => {
        setNotice(null);
        setOpen({ callerContext, context, group, candidates: input.candidates, fields: candidate?.inputs?.fields ?? NO_FIELDS, byChild });
      } },
    ...(open ? [{ key: 'close', title: `${t('common.close')}: ${input.title}`, description: `${testID}.groupInputs.close`,
      invoke: () => setOpen(null) }] : []),
  ] : [], { contextKey: `${testID}.groupInputs`, unbound: 'local' });
  const show = React.useCallback(() => { void commands.invoke('open'); }, [commands]);
  const close = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
  const repairChild = React.useCallback(async (target: RefusedChildInput) => {
    if (await commands.invoke('close')) setRepairTarget(target);
  }, [commands]);
  const childRepair = React.useMemo(() => repairTarget ? {
    childId: repairTarget.childId, fieldPath: repairTarget.fieldPath, consume: () => setRepairTarget(null),
  } : null, [repairTarget]);
  const done = React.useCallback((result: Extract<WidgetSetupSubmitResult, { ok: true }>) => {
    if (result.approvalPending) setNotice(t('widgetAdd.areaApprovalPending'));
    else close();
  }, [close]);
  // The Inputs… row names what is bound before its value (lab wgmenu M "Project: happier").
  const binding = React.useMemo(() => describeWidgetGroupInputsBinding(group.context, readings), [group.context, readings]);
  const editInputs = React.useMemo(
    () => (editable ? { onPress: show, binding } : undefined),
    [binding, editable, show],
  );
  const childTitle = input.childTitle;
  // Preserve the opening page, while letting the existing label owner withdraw a name during the edit.
  const readInherited = React.useMemo(() => open
    ? createGroupInheritedReader(open.group, open.candidates, scope?.owner, open.context, { ...readings, byChild: open.byChild }, open.fields, group.context)
    : undefined, [open, scope?.owner, readings, group.context]);
  const buildSetup = React.useCallback(() => {
    const bindings = group.context ?? {};
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
          bindings,
        },
      },
      scope,
      submit: (draft): Promise<WidgetSetupSubmitResult> =>
        runWidgetSetupCommand(
          async () => {
            setNotice(null);
            const result = await setInputs!(draft.bindings);
            if (result.ok) return result;
            const target = readRefusedChildInput(result.details);
            const blocked = target && group.children.find(({ instance }) => instance.id === target.childId);
            if (!blocked) return result;
            const descriptor = input.candidates.find(entry => entry &&
              isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(entry), blocked.instance.definition)) ?? null;
            const widget = childTitle?.(blocked.instance.id) ?? resolveWidgetInstanceTitle(blocked.instance, descriptor);
            return { ...result, message: t('widgetAdd.groupChildInputsInvalid', { widget }) };
          },
          t('widgetAdd.saveFailed'),
        ),
    });
    return {
      ...setup,
      ...(readInherited ? { readInherited } : {}),
      initial: { bindings },
      title: t('widgetFrame.groupInputsTitle', { group: input.title }),
      hint: t('widgetFrame.groupInputsHint'),
      widget: { title: input.title, mark: WIDGET_GROUP_ICON },
      renderPreview: ({ refusal }: Parameters<NonNullable<WidgetSetup['renderPreview']>>[0]) => (
        <WidgetGroupFollowers
          group={group}
          byChild={byChild}
          candidates={input.candidates}
          childTitle={childTitle}
          refusal={refusal}
          onRepair={repairChild}
          testID={`${testID}.groupInputs.followers`}
        />
      ),
    };
  }, [
    byChild,
    candidate,
    childTitle,
    context,
    group,
    input.title,
    input.candidates,
    readInherited,
    repairChild,
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
        readInherited={readInherited}
        onRequestClose={close}
        onDone={done}
        notice={notice}
        serverId={scope!.serverId}
        testID={`${testID}.groupInputs`}
      />
    ) : null;
  return { anchorRef, editInputs, popover, readings, childRepair };
}

/** Who follows the group and who keeps its own value, then the boundary: the group grants nothing. */
function WidgetGroupFollowers(
  props: Readonly<{
    group: WidgetLayoutGroupV1;
    byChild: WidgetGroupInputReadings['byChild'];
    candidates: readonly (WidgetCandidate | null)[];
    childTitle?: ((instanceId: string) => string) | undefined;
    refusal: Extract<WidgetSetupSubmitResult, { ok: false }> | undefined;
    onRepair: (target: RefusedChildInput) => Promise<void>;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const rows = React.useMemo(() => props.group.children.map((child) => {
    const follows = Boolean(props.byChild.get(child.instance.id)?.length);
    return {
      id: child.instance.id,
      title:
        props.childTitle?.(child.instance.id) ??
        resolveWidgetInstanceTitle(child.instance, props.candidates.find(candidate => candidate
          && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), child.instance.definition))),
      follows,
    };
  }), [props.group.children, props.byChild, props.candidates, props.childTitle]);
  const following = React.useMemo(() => rows.filter(row => row.follows).length, [rows]);
  const blocked = React.useMemo(() => readRefusedChildInput(props.refusal?.details), [props.refusal]);
  const reason = t('widgetAdd.invalidReason');
  return (
    <View testID={props.testID} style={styles.list}>
      <Text style={styles.heading}>
        {t('widgetFrame.groupFollowCount', { following, count: rows.length })}
      </Text>
      {rows.map((row) => blocked?.childId === row.id ? (
        <HappierPressable key={row.id} testID={`${props.testID}.${row.id}.repair`} style={styles.row}
          accessibilityRole="button" accessibilityLabel={`${row.title}, ${reason}`} onPress={() => { void props.onRepair(blocked); }}>
          <Text style={styles.title} numberOfLines={1}>{row.title}</Text>
          <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.danger.foreground} />
          <Text style={styles.meta}>{reason}</Text>
        </HappierPressable>
      ) : (
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
