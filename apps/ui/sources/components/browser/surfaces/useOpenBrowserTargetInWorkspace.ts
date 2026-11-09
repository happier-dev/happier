import * as React from 'react';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/useDesktopWebViewNativeAvailability';
import { registerBrowserRuntimeWorkspaceOpeningAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { usePaneRegion } from '@/components/appShell/panes/paneRegion';
import { createOpenBrowserTargetInWorkspace, type CreateOpenBrowserTargetInWorkspaceDeps } from './openBrowserTargetInWorkspace';

/** Workspace presentation lifetime exists before any Browser view is rendered. */
export function useOpenBrowserTargetInWorkspace(
    deps: CreateOpenBrowserTargetInWorkspaceDeps,
    options?: Readonly<{ register?: boolean }>,
) {
    const browserFeatureDecision = useFeatureDecision('browser', deps.accountLifetime
        ? { scopeKind: 'spawn', serverId: deps.accountLifetime.scope.serverId }
        : { scopeKind: 'runtime' });
    const desktopWebViewAvailability = useDesktopWebViewNativeAvailability({
        platform: deps.platform, availability: deps.desktopWebViewAvailability,
    });
    const paneRegion = usePaneRegion();
    const openerRegion = React.useRef(paneRegion);
    openerRegion.current = paneRegion;
    const facts = React.useRef(deps);
    facts.current = { ...deps, browserFeatureDecision: deps.browserFeatureDecision ?? browserFeatureDecision,
        desktopWebViewAvailability };
    const binding = React.useMemo(() => {
        const lifetime = { current: true, controller: new AbortController() };
        const open = createOpenBrowserTargetInWorkspace({ ...deps,
            // Presentation can rebind while a preview is being registered. Its
            // current callback belongs to the same Account/workspace lifetime.
            openDetailsTab: (...args) => facts.current.openDetailsTab(...args),
            get signal() { return lifetime.controller.signal; },
            readOpenFacts: () => ({ ...facts.current, ...facts.current.readOpenFacts?.() }),
            readOpenerRegion: () => (openerRegion.current === 'main' || openerRegion.current === 'side' ? openerRegion.current : null),
            isCurrent: () => lifetime.current && facts.current.accountLifetime === deps.accountLifetime
                && facts.current.scopeId === deps.scopeId && facts.current.scope === deps.scope,
        });
        return { open, lifetime };
    }, [deps.scopeId, deps.scope, deps.accountLifetime]);
    React.useEffect(() => {
        binding.lifetime.current = true;
        if (binding.lifetime.controller.signal.aborted) binding.lifetime.controller = new AbortController();
        // Panels consume the scope's Action without replacing its mounted driver's producer.
        const unregister = options?.register === false ? () => {}
            : registerBrowserRuntimeWorkspaceOpeningAdapter(binding.open.runtimeAdapter);
        return () => { binding.lifetime.current = false; binding.lifetime.controller.abort(); unregister(); };
    }, [binding, options?.register]);
    return binding.open;
}
