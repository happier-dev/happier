import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

import { resolveExecutionRunSelectionLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import type { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

/**
 * The launcher's route chip (RT4, D9): a new Run follows the session unless the draft carries its
 * own choice. `inheritDetail` is what following the session means right now ("<route> · <model>"),
 * read from the parent's applied route; it is null when that is not known, never guessed.
 */
export function resolveExecutionRunRouteChoice(input: Readonly<{
    /** The draft has no model or route of its own and targets the parent's Agent. */
    inherits: boolean;
    inheritedSelection: ProviderBoundModelRef | null;
    inheritedRoutePresentation: ReturnType<typeof resolveSessionRoutePresentation> | null;
}>): Readonly<{ label: string; inheritDetail: string | null }> {
    const applied = input.inheritedRoutePresentation?.applied ?? null;
    const source = applied && applied.kind !== 'unknown' ? applied.sourceLabel : null;
    const model = input.inheritedSelection?.modelId ?? null;
    const inheritDetail = [source, model].filter((part): part is string => Boolean(part)).join(' · ') || null;
    if (!input.inherits) return { label: t('runPage.menu.selectionExplicit'), inheritDetail };
    // The same words the started Run's header uses, from the same label owner.
    const label = input.inheritedSelection
        ? resolveExecutionRunSelectionLabel(
            { source: 'inherited', modelSelection: input.inheritedSelection },
            (connectionId) => applied?.kind === 'provider' && applied.connectionId === connectionId ? applied.sourceLabel : null,
        )
        : null;
    return { label: label ?? t('runPage.menu.selectionInherited'), inheritDetail };
}
