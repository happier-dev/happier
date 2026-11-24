import { useMemo } from 'react';
import { readInputPath, type InputFieldHint } from '@happier-dev/protocol/inputs';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    composeWidgetGroupContextV1,
    readWidgetInputTargetV1,
    resolveConfiguredWidgetInputs,
    type WidgetInputBindingsV1,
    type WidgetInputDescriptorV1,
    type WidgetInstanceV1,
    type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { WIDGET_SESSION_CONTEXT_SLOT, widgetProvidedContext, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import { describeWidgetBindingPinValue, describeWidgetPageBindingValue, type WidgetBindingLabelField, type WidgetBindingValueLabels } from '../surface/widgetBindingValueLabel';
import type { WidgetGroupHeaderReading } from './widgetGroupInputs';

export type WidgetGroupInputReadings = Readonly<{
    fields: readonly WidgetBindingLabelField[];
    declared?: readonly InputFieldHint[];
    byChild: ReadonlyMap<string, readonly WidgetBindingLabelField[]>;
    labels: WidgetBindingValueLabels;
}>;

export function readWidgetGroupInputFollowers(instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1): readonly WidgetBindingLabelField[] {
    const target = readWidgetInputTargetV1(descriptor);
    return (descriptor.inputs?.fields ?? []).flatMap(field => {
        const binding = instance.bindings[field.path];
        return field.contextMode !== 'own' && !field.connectedAccountOptions && binding?.kind === 'context'
            ? [{ field, slot: binding.slot, sessionTarget: target.kind === 'session' && target.path === field.path }] : [];
    });
}

/** The editor and card read the same configured inputs. Captions are looked up by the bound slot. */
export function createWidgetGroupFollowedInputReader(input: Readonly<{
    context: WidgetSurfaceContext;
    surfaceOwner: WidgetSurfaceRefV1['owner'] | undefined;
    bindings: WidgetInputBindingsV1;
    labelledBindings: WidgetInputBindingsV1 | undefined;
    labels: WidgetBindingValueLabels | undefined;
    fields: readonly WidgetBindingLabelField[];
}>) {
    const { context, surfaceOwner, bindings, labelledBindings, labels, fields } = input;
    const composed = composeWidgetGroupContextV1({
        providedContext: widgetProvidedContext(context), surfaceOwner, groupBindings: bindings,
    });
    return (instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1) => {
        const resolved = resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: composed, viewerValues: {} });
        return ({ field, slot }: WidgetBindingLabelField) => {
            const value = resolved.status === 'ready' ? readInputPath(resolved.input, field.path) as JsonValue | undefined : undefined;
            if (value === undefined) return null;
            const binding = bindings[slot];
            if (binding?.kind === 'value') {
                const labelled = labelledBindings?.[slot];
                if (labelled?.kind === 'value' && sameStrictJsonValue(labelled.value, value)) {
                    return { value, label: labels?.[slot] ?? null };
                }
                let label: string | null | undefined;
                for (const declared of fields) {
                    if (declared.slot !== slot) continue;
                    const next = describeWidgetBindingPinValue(declared.field, value, declared.sessionTarget, true) ?? null;
                    if (label !== undefined && label !== next) return { value, label: null };
                    label = next;
                }
                return { value, label: label ?? null };
            }
            const pageSlot = binding?.kind === 'context' ? binding.slot : slot;
            const slotLabel = pageSlot === WIDGET_SESSION_CONTEXT_SLOT && context.session
                ? context.session.label : context.slots?.[pageSlot]?.value?.label;
            return { value, label: describeWidgetPageBindingValue(field, value, slotLabel) };
        };
    };
}

/** A card has one source line. The first group-supplied field keeps it as the context settles. */
export function useWidgetGroupCardSource(
    instance: WidgetInstanceV1,
    descriptor: WidgetInputDescriptorV1 | null | undefined,
    context: WidgetSurfaceContext,
    surfaceOwner: WidgetSurfaceRefV1['owner'] | undefined,
    bindings: WidgetInputBindingsV1 | undefined,
    readings: WidgetGroupInputReadings | undefined,
    header: WidgetGroupHeaderReading = null,
): Readonly<{ value: string; namedInHeader: boolean }> | null {
    return useMemo(() => {
        if (!bindings || !descriptor || !readings) return null;
        const followed = readings.byChild.get(instance.id)?.find(({ slot }) => Object.hasOwn(bindings, slot));
        if (!followed) return null;
        const { field, slot } = followed;
        if (header?.binding?.slot === slot) return { value: header.binding.value, namedInHeader: true };
        // A named group's alias leaves the card's ordinary source in place when the header has no reading for it.
        if (header && bindings[slot]?.kind === 'context') return null;
        const readChild = createWidgetGroupFollowedInputReader({ context, surfaceOwner, bindings, labelledBindings: bindings,
            labels: readings.labels, fields: readings.fields });
        return { value: readChild(instance, descriptor)(followed)?.label ?? field.title, namedInHeader: false };
    }, [instance, descriptor, context, surfaceOwner, bindings, readings, header]);
}
