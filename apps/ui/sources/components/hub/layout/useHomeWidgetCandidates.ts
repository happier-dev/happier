import * as React from 'react';

import { useAppShellPluginUiProjectionModel } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { selectWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useAtmosphereMoments } from '@/components/atmosphere/atmosphereMoments';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';

function sameCandidates(left: readonly WidgetCandidate[], right: readonly WidgetCandidate[]): boolean {
    return left.length === right.length && left.every((candidate, index) => {
        const other = right[index]!;
        return candidate.key === other.key
            && candidate.title === other.title
            && candidate.description === other.description
            && candidate.pluginName === other.pluginName
            && candidate.sharedPluginName === other.sharedPluginName
            && candidate.icon === other.icon
            && candidate.homeDefault === other.homeDefault
            && candidate.target === other.target
            && candidate.sessionInputPath === other.sessionInputPath
            && stableJsonStringify(candidate.inputSchema) === stableJsonStringify(other.inputSchema)
            && stableJsonStringify(candidate.connectedAccountPurposeBindings) === stableJsonStringify(other.connectedAccountPurposeBindings)
            && stableJsonStringify(candidate.sizeDeclaration) === stableJsonStringify(other.sizeDeclaration)
            && stableJsonStringify(candidate.inputs) === stableJsonStringify(other.inputs);
    });
}

/**
 * The installed App-target widgets Home may show. The inventory is recomputed only when the app
 * shell's plugin projection changes, and keeps its previous identity when that change leaves the
 * widgets as they were — so an unrelated plugin update re-renders no hub section. Built-ins follow
 * the atmosphere's moment switches (Your Home), so turning one off withdraws it here at once. A widget's own
 * data never passes through here: each mounted widget subscribes to its placement, so a data change
 * stays inside that widget.
 */
export function useHomeWidgetCandidates(localize?: PluginLocalizedTextResolver, policyContext?: PluginUiPolicyEvaluationContext): readonly WidgetCandidate[] {
    const projection = useAppShellPluginUiProjectionModel();
    const moments = useAtmosphereMoments();
    const previous = React.useRef<readonly WidgetCandidate[] | null>(null);
    return React.useMemo(() => {
        const next = selectWidgetCandidates(projection, policyContext, moments, localize);
        if (previous.current && sameCandidates(previous.current, next)) return previous.current;
        previous.current = next;
        return next;
    }, [projection, moments, localize, policyContext]);
}
