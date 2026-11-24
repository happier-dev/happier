import { readWidgetInputTargetV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';
import { useWidgetBindingValueLabels } from './useWidgetBindingValueLabels';

/**
 * What a copy is bound to, for its frame's source slot (lab `dashboards` dbind N1): the binding names
 * the copy, so two Summaries read "Retry relay handshake on 503" and "Fix settings modal remount"
 * without anyone typing a name. A followed Session reads "This session"; a pinned one, that Session's
 * name; an input following a page or project slot reads that slot's label ("This page", "This
 * checkout"); otherwise the first pinned plain value. `null` leaves the slot to the widget's source.
 */
export function useWidgetInstanceBindingLabel(
    instance: Pick<WidgetInstanceV1, 'bindings'>,
    candidate: Pick<WidgetCandidate, 'inputs' | 'sessionInputPath'> | null | undefined,
    context?: WidgetSurfaceContext,
): string | null {
    const target = readWidgetInputTargetV1(candidate ?? {});
    const sessionPath = target.kind === 'session' ? target.path : undefined;
    const sessionBinding = sessionPath ? instance.bindings[sessionPath] : undefined;
    const labels = useWidgetBindingValueLabels(instance.bindings, candidate);
    if (sessionBinding?.kind === 'context' && !context?.slots?.[sessionBinding.slot]?.groupAlias) return t('widgetAdd.thisSession');
    if (sessionPath && sessionBinding?.kind === 'value') return labels[sessionPath] ?? null;
    for (const field of candidate?.inputs?.fields ?? []) {
        const binding = instance.bindings[field.path];
        const slot = binding?.kind === 'context' && context?.slots && Object.hasOwn(context.slots, binding.slot) ? context.slots[binding.slot] : undefined;
        if (slot && !slot.groupAlias) return slot.label;
    }
    for (const field of candidate?.inputs?.fields ?? []) {
        const binding = instance.bindings[field.path];
        if (binding?.kind !== 'value') continue;
        const label = labels[field.path];
        if (label) return label;
    }
    return null;
}

/**
 * Whether a copy follows one of its surface's own named slots ("This checkout" on a Project page),
 * as opposed to a value pinned to it. A surface whose header already names that slot leaves the
 * follow label out of each frame; the copy's inputs editor still reads it from the label above.
 */
export function isWidgetFollowingSurfaceSlot(
    instance: Pick<WidgetInstanceV1, 'bindings'>,
    context?: WidgetSurfaceContext,
): boolean {
    const slots = context?.slots;
    if (!slots) return false;
    return Object.values(instance.bindings).some(binding => binding.kind === 'context' && Object.hasOwn(slots, binding.slot) && !slots[binding.slot]?.groupAlias);
}
