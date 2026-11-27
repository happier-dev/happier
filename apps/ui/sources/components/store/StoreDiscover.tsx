import * as React from 'react';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useRegistryCuration, type RegistryCuration } from '@/registries/useRegistrySuggestions';
import { matchRegistryProjectSuggestions, type RegistryProjectSuggestion } from '@/registries/registryProjectSuggestions';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readProjectAccountWorkspaceRefs, useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import type { StoreDemand } from './catalog/storeKinds';
import { useAdmittedStoreProject } from '@/components/settings/plugins/model/useStoreProjectScope';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';

/** Discover's single catalog acquisition and held-fact binding; S40-UI owns visual slots. */
export function StoreDiscover(props: Readonly<{
    demand: StoreDemand;
    sourceIds?: readonly string[];
    sections?: readonly string[];
    project: QualifiedProjectKeyV1 | null;
    children: (state: Readonly<{ curation: RegistryCuration;
        suggestions: readonly RegistryProjectSuggestion[];
        /** The read owner's presentation decision also owns demand for the displayed choices' summaries. */
        presented: boolean;
        /** Every admitted catalog read settled without a failure: the one completeness decision Store pages read. */
        complete: boolean }>) => React.ReactNode;
}>): React.ReactNode {
    const lifetime = useActiveServerAccountScopeLifetime();
    const focused = useIsFocused();
    const visible = useLayoutPresentationActive();
    const presented = props.demand.presented && focused && visible && !!lifetime?.isCurrent();
    const { project } = useAdmittedStoreProject(presented ? props.project : null);
    const curation = useRegistryCuration({ sourceIds: props.sourceIds }, presented);
    const mappings = curation.curation.some(page => (page.discovery.suggestions?.length ?? 0) > 0);
    const refs = useProjectAccountRows(rows => lifetime?.isCurrent()
        && areServerAccountScopesEqual(rows?.scope, lifetime.scope)
        ? readProjectAccountWorkspaceRefs({ projectAccountRows: rows }) : undefined,
    presented && mappings && project !== null);
    // Matching runs per render (it reads the live server-profile projection); an equal result keeps its identity, so
    // a curation publication that changes no suggestion leaves the shelves that read them still.
    const retained = React.useRef<readonly RegistryProjectSuggestion[] | undefined>(undefined);
    const suggestions = retainDeep(retained.current, matchRegistryProjectSuggestions(curation.curation,
        project, refs, workspaceRefResolutionContextV1()));
    React.useEffect(() => { retained.current = suggestions; });
    const complete = !curation.loading && !curation.error && curation.sourceFailures.length === 0;
    return <>
        <PluginSurfaceProjectionDemand accountScope={lifetime?.scope ?? null} enabled={presented} presents="allInstallations"
            sections={props.sections} />
        {props.children({ curation, suggestions, complete, presented })}
    </>;
}
