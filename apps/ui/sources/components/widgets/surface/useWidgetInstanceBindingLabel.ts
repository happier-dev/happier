import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useSession } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

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
    const sessionPath = candidate?.sessionInputPath;
    const sessionBinding = sessionPath ? instance.bindings[sessionPath] : undefined;
    const pinned = sessionBinding?.kind === 'value' ? VoiceTrackedSessionAddressV1Schema.safeParse(sessionBinding.value) : null;
    const ref = pinned?.success ? pinned.data : null;
    const session = useSession(ref?.sessionId ?? '', ref?.serverId ?? null);
    if (sessionBinding?.kind === 'context') return t('widgetAdd.thisSession');
    if (ref) return session ? getSessionName(session, ref.serverId) : null;
    for (const field of candidate?.inputs?.fields ?? []) {
        const binding = instance.bindings[field.path];
        const slot = binding?.kind === 'context' && context?.slots && Object.hasOwn(context.slots, binding.slot) ? context.slots[binding.slot] : undefined;
        if (slot) return slot.label;
    }
    for (const field of candidate?.inputs?.fields ?? []) {
        const binding = instance.bindings[field.path];
        if (binding?.kind !== 'value') continue;
        // A choice reads as its option's words, never its stored value ("Automatic", not "auto").
        if (typeof binding.value === 'string' && binding.value.length > 0) {
            const option = field.options?.find(candidate => candidate.value === binding.value);
            if (option && typeof option.label === 'string') return option.label;
            // A stored choice is an identifier, not words: when its option's words are not known here
            // (a host- or source-owned choice), the slot is left to the widget's own source.
            if (field.options || field.optionsSourceId || field.inputType) continue;
            return binding.value;
        }
        if (typeof binding.value === 'number') return String(binding.value);
    }
    return null;
}
