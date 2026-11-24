import { useMemo } from 'react';
import { resolveHappierActionFieldPresentation } from '@happier-dev/plugin-ui/presentation';
import { isSameInputOptionValue, readInputPath, type InputFieldHint } from '@happier-dev/protocol/inputs';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    composeWidgetGroupContextV1,
    resolveConfiguredWidgetInputs,
    type WidgetInputBindingsV1,
    type WidgetInputDescriptorV1,
    type WidgetInstanceV1,
    type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { describeHostInputTypePickerValue } from '@/components/sessions/actions/hostInputTypePickerForm';
import { WIDGET_SESSION_CONTEXT_SLOT, widgetProvidedContext, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import type { WidgetBindingValueLabels } from '../surface/useWidgetBindingValueLabels';

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
}>) {
    const { context, surfaceOwner, bindings, labelledBindings, labels } = input;
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
                const slotLabel = labelled?.kind === 'value' && sameStrictJsonValue(labelled.value, value) ? labels?.[slot] ?? null : null;
                return { value, slotLabel };
            }
            const pageSlot = binding?.kind === 'context' ? binding.slot : slot;
            const slotLabel = pageSlot === WIDGET_SESSION_CONTEXT_SLOT && context.session
                ? context.session.label : context.slots?.[pageSlot]?.value?.label ?? null;
            return { value, slotLabel };
        };
    };
}

export function describeWidgetGroupFollowedInput(field: InputFieldHint, reading: {
    value: JsonValue;
    slotLabel: string | null;
}): string | null {
    const { value, slotLabel } = reading;
    const option = field.options?.find(option => isSameInputOptionValue(option.value, value));
    if (option) return option.label;
    if (slotLabel) return slotLabel;

    const typedLabel = field.inputType && 'hostType' in field.inputType
        ? describeHostInputTypePickerValue(field.inputType, value) : null;
    if (typedLabel) return typedLabel;
    if (field.allowCustomValue && typeof value === 'string') return value;
    if (typeof value !== 'string' && typeof value !== 'number' && field.widget !== 'text_list' && field.widget !== 'json') return null;
    const presentation = resolveHappierActionFieldPresentation(field, value);
    return presentation.kind === 'text' && !presentation.secure ? presentation.value : null;
}

/** A card has one source line. The first group-supplied field keeps it as the context settles. */
export function useWidgetGroupFollowedValue(
    instance: WidgetInstanceV1,
    descriptor: WidgetInputDescriptorV1 | null | undefined,
    context: WidgetSurfaceContext,
    surfaceOwner: WidgetSurfaceRefV1['owner'] | undefined,
    bindings: WidgetInputBindingsV1 | undefined,
    labels: WidgetBindingValueLabels | undefined,
): string | null {
    return useMemo(() => {
        if (!bindings || !descriptor) return null;
        const followed = readWidgetGroupInputFollowers(instance, descriptor).find(({ slot }) => Object.hasOwn(bindings, slot));
        if (!followed) return null;
        const { field, slot } = followed;
        const readChild = createWidgetGroupFollowedInputReader({ context, surfaceOwner, bindings, labelledBindings: bindings, labels });
        const reading = readChild(instance, descriptor)(field, slot);
        return (reading && describeWidgetGroupFollowedInput(field, reading)) || field.title;
    }, [instance, descriptor, context, surfaceOwner, bindings, labels]);
}
