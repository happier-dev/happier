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

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { WIDGET_SESSION_CONTEXT_SLOT, widgetProvidedContext, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import { describeWidgetBindingPinValue, describeWidgetGroupFollowedInput, type WidgetBindingValueLabels } from '../surface/widgetBindingValueLabel';
import { readWidgetGroupInputCandidate, type WidgetGroupHeaderReading } from './widgetGroupInputs';

export function readWidgetGroupInputFollowers(instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1) {
    return (descriptor.inputs?.fields ?? []).flatMap(field => {
        const binding = instance.bindings[field.path];
        return field.contextMode !== 'own' && !field.connectedAccountOptions && binding?.kind === 'context'
            ? [{ field, slot: binding.slot }] : [];
    });
}

/** The editor and card read the same configured inputs. Captions are looked up by the bound slot. */
export function createWidgetGroupFollowedInputReader(input: Readonly<{
    context: WidgetSurfaceContext;
    surfaceOwner: WidgetSurfaceRefV1['owner'] | undefined;
    bindings: WidgetInputBindingsV1;
    labelledBindings: WidgetInputBindingsV1 | undefined;
    labels: WidgetBindingValueLabels | undefined;
    fieldCandidates?: readonly (WidgetCandidate | null)[];
}>) {
    const { context, surfaceOwner, bindings, labelledBindings, labels, fieldCandidates } = input;
    const composed = composeWidgetGroupContextV1({
        providedContext: widgetProvidedContext(context), surfaceOwner, groupBindings: bindings,
    });
    return (instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1) => {
        const resolved = resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: composed, viewerValues: {} });
        return (field: InputFieldHint, slot: string) => {
            const value = resolved.status === 'ready' ? readInputPath(resolved.input, field.path) as JsonValue | undefined : undefined;
            if (value === undefined) return null;
            const binding = bindings[slot];
            if (binding?.kind === 'value') {
                const labelled = labelledBindings?.[slot];
                if (labels && Object.hasOwn(labels, slot) && labelled?.kind === 'value' && sameStrictJsonValue(labelled.value, value)) {
                    return { value, slotLabel: labels[slot] };
                }
                // A fresh draft pin has no inventory label. Apply the same owner's withholding rule using its declaration.
                const source = fieldCandidates && readWidgetGroupInputCandidate(fieldCandidates, slot);
                const sourceField = source?.inputs?.fields.find(entry => entry.path === slot) ?? field;
                const target = readWidgetInputTargetV1(source ?? descriptor);
                const label = describeWidgetBindingPinValue(sourceField, value, target.kind === 'session' && target.path === sourceField.path);
                return { value, slotLabel: label === null ? null : undefined };
            }
            const pageSlot = binding?.kind === 'context' ? binding.slot : slot;
            const slotLabel = pageSlot === WIDGET_SESSION_CONTEXT_SLOT && context.session
                ? context.session.label : context.slots?.[pageSlot]?.value?.label;
            return { value, slotLabel };
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
    labels: WidgetBindingValueLabels | undefined,
    header: WidgetGroupHeaderReading = null,
): Readonly<{ value: string; namedInHeader: boolean }> | null {
    return useMemo(() => {
        if (!bindings || !descriptor) return null;
        const followed = readWidgetGroupInputFollowers(instance, descriptor).find(({ slot }) => Object.hasOwn(bindings, slot));
        if (!followed) return null;
        const { field, slot } = followed;
        if (header?.binding?.slot === slot) return { value: header.binding.value, namedInHeader: true };
        // A named group's alias leaves the card's ordinary source in place when the header has no reading for it.
        if (header && bindings[slot]?.kind === 'context') return null;
        const readChild = createWidgetGroupFollowedInputReader({ context, surfaceOwner, bindings, labelledBindings: bindings, labels });
        const reading = readChild(instance, descriptor)(field, slot);
        return { value: (reading && describeWidgetGroupFollowedInput(field, reading)) || field.title, namedInHeader: false };
    }, [instance, descriptor, context, surfaceOwner, bindings, labels, header]);
}
