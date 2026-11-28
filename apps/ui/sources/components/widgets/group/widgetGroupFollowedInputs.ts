import { useMemo } from 'react';
import { readInputPath } from '@happier-dev/protocol/inputs';
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

import { readWidgetSurfaceSlotLabel, widgetProvidedContext, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import { describeWidgetBindingPinValue, describeWidgetPageBindingValue, readWidgetBindingFieldTitle, summarizeWidgetBindingReadings, type WidgetBindingLabelField, type WidgetBindingReading, type WidgetBindingValueLabels, type WidgetBindingValueSource } from '../surface/widgetBindingValueLabel';
import type { WidgetGroupHeaderReading } from './widgetGroupInputs';

export type WidgetGroupInputReadings = Readonly<{
    fields: readonly WidgetBindingLabelField[];
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

export type WidgetGroupFollowedInputReading = WidgetBindingReading & Readonly<{ source: WidgetBindingValueSource }>;

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
        return ({ field, slot }: WidgetBindingLabelField): WidgetGroupFollowedInputReading | null => {
            const value = resolved.status === 'ready' ? readInputPath(resolved.input, field.path) as JsonValue | undefined : undefined;
            if (value === undefined) return null;
            const binding = bindings[slot];
            if (binding?.kind === 'value') {
                const labelled = labelledBindings?.[slot];
                if (labelled?.kind === 'value' && sameStrictJsonValue(labelled.value, value)) {
                    return { value, label: labels?.[slot] ?? null, source: 'group' };
                }
                const summary = summarizeWidgetBindingReadings(fields.filter(declared => declared.slot === slot).map(declared => ({
                    value, label: describeWidgetBindingPinValue(declared.field, value, declared.sessionTarget, true),
                })));
                return { value, label: summary?.kind === 'single' ? summary.label : null, source: 'group' };
            }
            const pageSlot = binding?.kind === 'context' ? binding.slot : slot;
            return { value, label: describeWidgetPageBindingValue(field, value, readWidgetSurfaceSlotLabel(context, pageSlot)), source: 'page' };
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
        const { slot } = followed;
        if (header?.binding?.slot === slot) return { value: header.binding.value, namedInHeader: true };
        // A named group's alias leaves the card's ordinary source in place when the header has no reading for it.
        if (header && bindings[slot]?.kind === 'context') return null;
        const readChild = createWidgetGroupFollowedInputReader({ context, surfaceOwner, bindings, labelledBindings: bindings,
            labels: readings.labels, fields: readings.fields });
        const summary = summarizeWidgetBindingReadings([readChild(instance, descriptor)(followed)]);
        const value = summary?.kind === 'single' ? summary.label
            : readWidgetBindingFieldTitle(slot, readings.fields.filter(declaration => declaration.slot === slot));
        return { value, namedInHeader: false };
    }, [instance, descriptor, context, surfaceOwner, bindings, readings, header]);
}
