import { useMemo } from 'react';
import type { InputFieldHint } from '@happier-dev/protocol/inputs/inputFields';
import type {
  WidgetInputBindingsV1,
} from '@happier-dev/protocol/widgets';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { HappierWidgetFrameSourceDescriptor } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import type { WidgetGroupInputReadings } from './widgetGroupFollowedInputs';

/** The displayed pin and the slot it belongs to. A missing name has no replacement value. */
export function readWidgetGroupHeaderBinding(
  context: WidgetInputBindingsV1 | undefined,
  readings: Pick<WidgetGroupInputReadings, 'fields' | 'declared' | 'labels'>,
): Readonly<{ slot: string; title: string; value: string | null }> | null {
  let first: ReturnType<typeof readWidgetGroupHeaderBinding> = null;
  for (const [slot, binding] of Object.entries(context ?? {})) {
    if (binding.kind !== 'value') continue;
    const field = readings.fields.find(entry => entry.slot === slot)?.field;
    const title = field?.title ?? readings.declared?.find(entry => entry.path === slot)?.title ?? slot;
    const pin = { slot, title, value: field ? readings.labels[slot] ?? null : null };
    if (pin.value) return pin;
    first ??= pin;
  }
  return first;
}

export type WidgetGroupHeaderReading = Readonly<{
  binding: Readonly<{ slot: string; value: string }> | null;
  source: HappierWidgetFrameSourceDescriptor | undefined;
}> | null;

/** A title alone does not replace the child's source. Only the pin value actually drawn does. */
export function useWidgetGroupHeaderReading(
  titled: boolean,
  context: WidgetInputBindingsV1 | undefined,
  readings: WidgetGroupInputReadings,
): WidgetGroupHeaderReading {
  return useMemo(() => {
    if (!titled) return null;
    const pin = readWidgetGroupHeaderBinding(context, readings);
    return { binding: pin?.value ? { slot: pin.slot, value: pin.value } : null,
      source: pin ? widgetGroupPinnedSource(pin.value ?? pin.title) : undefined };
  }, [titled, context, readings]);
}

export function describeWidgetGroupInputsBinding(
  context: WidgetInputBindingsV1 | undefined,
  readings: WidgetGroupInputReadings,
): string | null {
  const pin = readWidgetGroupHeaderBinding(context, readings);
  return pin?.value ? t('widgetFrame.groupInputsValue', { field: pin.title, value: pin.value }) : pin?.title ?? null;
}

/**
 * The slots a group can fill for its widgets: every follow-able input, once each (an input
 * follows the slot its path names). The first widget to declare a path supplies its field.
 */
export function collectWidgetGroupInputFields(
  candidates: readonly (WidgetCandidate | null | undefined)[],
): InputFieldHint[] {
  const fields = new Map<string, InputFieldHint>();
  for (const candidate of candidates) {
    for (const field of candidate?.inputs?.fields ?? [])
      if (!fields.has(field.path) && field.contextMode !== 'own' && !field.connectedAccountOptions)
        fields.set(field.path, field);
  }
  return [...fields.values()];
}

/** Option discovery uses the same eligible declaration as the group's fields and schema. */
export function readWidgetGroupInputCandidate(
  candidates: readonly (WidgetCandidate | null | undefined)[],
  path: string,
): WidgetCandidate | undefined {
  return candidates.find((candidate): candidate is WidgetCandidate => !!candidate?.inputs?.fields.some(
    field => field.path === path && field.contextMode !== 'own' && !field.connectedAccountOptions,
  ));
}

/**
 * The group's inputs as a widget candidate for the shared Set up step (A4): the same fields, value
 * buttons and options owner, keyed by the slots the widgets follow. The group grants nothing; each
 * widget still resolves and admits its own read.
 */
export function buildWidgetGroupInputsCandidate(
  input: Readonly<{
    title: string;
    candidates: readonly (WidgetCandidate | null | undefined)[];
  }>,
): WidgetCandidate | null {
  const fields = collectWidgetGroupInputFields(input.candidates);
  const source = input.candidates.find((candidate) =>
    candidate?.inputs?.fields.some((field) =>
      fields.includes(field),
    ),
  );
  if (!source || fields.length === 0) return null;
  const properties = Object.fromEntries(
    fields.flatMap((field) => {
      const owner = readWidgetGroupInputCandidate(input.candidates, field.path);
      const schema = owner?.inputSchema?.properties?.[field.path];
      return schema ? [[field.path, schema]] : [];
    }),
  );
  return {
    ...source,
    title: input.title,
    inputs: { ...source.inputs, fields },
    ...(source.inputSchema || Object.keys(properties).length > 0
      ? { inputSchema: { type: 'object', properties } }
      : {}),
  };
}

/** The group's slots for a child's own Edit inputs: following the group is one of its choices. */
export function widgetGroupSurfaceContext(
  base: WidgetSurfaceContext,
  context: WidgetInputBindingsV1 | undefined,
  readings?: WidgetGroupInputReadings,
): WidgetSurfaceContext {
  if (!context) return base;
  const slots: Record<
    string,
    NonNullable<WidgetSurfaceContext['slots']>[string]
  > = { ...base.slots };
  for (const [slot, binding] of Object.entries(context)) {
    if (binding.kind !== 'value') continue;
    slots[slot] = {
      label: t('widgetFrame.followingGroup'),
      value: {
        value: binding.value,
        label: readings?.labels[slot] ?? null,
      },
    };
  }
  return { ...base, slots };
}

/** A group header's source: the group's own chosen value, with the pin it is set by. */
export function widgetGroupPinnedSource(value: string): HappierWidgetFrameSourceDescriptor {
  return { binding: 'pin', text: value };
}

/**
 * A grouped widget's source (lab wginputs): "Following group · Last 90 days". A cell
 * with room keeps the phrase and falls
 * back to the value when the frame narrows; a half cell shows the follow glyph and the value at once.
 * Either way the phrase is the line's accessible name.
 */
export function widgetGroupFollowSource(value: string, roomy: boolean): HappierWidgetFrameSourceDescriptor {
  const phrase = t('widgetFrame.followingGroupValue', { value });
  return roomy
    ? { binding: 'follow', text: phrase, compactText: value }
    : { binding: 'follow', text: value, accessibilityLabel: phrase };
}
