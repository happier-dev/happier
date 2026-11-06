import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { usePluginExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { normalizeCredentialScopeServerId, useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';

/**
 * An opened Machine-backed surface needs discovery before Administration can
 * select an executable origin. Administration ranks Account descriptors into
 * one read intent before admitting that Machine's actual source. Surfaces
 * presenting every Machine's contributions (the Store) ask each installation
 * for its UI sections.
 */
export function PluginSurfaceProjectionDemand(props: Readonly<{
    pluginId?: string;
    accountScope: ServerAccountScope | null;
    enabled?: boolean;
    /** `all`: the surface presents every installation's contributions, not one selected origin. */
    presents?: 'selectedOrigin' | 'allInstallations';
}>): React.ReactElement {
    const active = useLayoutPresentationActive();
    const presented = props.enabled !== false && active;
    const availability = usePluginAccountAvailabilityReader(props.accountScope, props.pluginId, { enabled: presented });
    const installed = presented ? availability?.readInstalledPlugins() : null;
    const selectedOrigin = props.pluginId !== undefined && props.presents !== 'allInstallations';
    const targets = React.useMemo(() => {
        const targets = new Map<string, MachineAdministrationTargetV1>();
        if (presented && !selectedOrigin && installed?.kind === 'available') {
            for (const plugin of installed.plugins) {
                if (props.pluginId !== undefined && plugin.pluginId !== props.pluginId) continue;
                for (const installation of plugin.installations) {
                    const { serverIdentityId, machineId } = installation.materialization;
                    const key = JSON.stringify([serverIdentityId, machineId]);
                    if (!targets.has(key)) targets.set(key, { serverIdentityId, machineId });
                }
            }
        }
        return [...targets.entries()];
    }, [installed, presented, props.pluginId, selectedOrigin]);
    const hosted = useHostedDemands(targets, 'presentation');
    // Administration's uncontextual selection is plugin-scoped, so one presented body decides it for all.
    const decides = selectedOrigin && presented;
    const selection = React.useMemo(() => decides ? [[props.pluginId!, props.pluginId!] as const] : [], [decides, props.pluginId]);
    const hostedSelection = useHostedDemands(selection, 'selectedOrigin');
    // One credential read per surface: Machine demands borrow their Home's lifetime (null until it binds), so
    // N Machines do not each read the same credential and wake separately when it answers.
    const homeIds = React.useMemo(() => hosted.map(([, target]) => target.serverIdentityId), [hosted]);
    const bindings = useServerCredentialAccountScopeBindings(homeIds);
    // A surface render (an Availability publication) does not redraw its unchanged Machine demands.
    const sourceDemands = React.useMemo(() => hosted.map(([key, target]) => <SourceDemand key={key} target={target} sections={PLUGIN_UI_SECTIONS}
        accountLifetime={bindings.get(normalizeCredentialScopeServerId(target.serverIdentityId)) ?? null} />), [bindings, hosted]);
    return <>
        {sourceDemands}
        {hostedSelection.map(([key, pluginId]) => <SelectedOriginDemand key={key} pluginId={pluginId} />)}
    </>;
}

function SourceDemand(props: Readonly<{ target: MachineAdministrationTargetV1;
    sections: readonly string[]; accountLifetime: ServerAccountScopeLifetime | null }>): null {
    usePluginExecutionOriginProjectionDemand(props.target, { sections: props.sections, accountLifetime: props.accountLifetime, observe: false });
    return null;
}

/** Administration's selected origin, and only it, acquires its presented UI sections. It renders no Run-on choice. */
function SelectedOriginDemand(props: Readonly<{ pluginId: string }>): null {
    usePluginSurfaceExecutionOrigin({ pluginId: props.pluginId, projection: null, enabled: true, includeMachineCandidates: false });
    return null;
}

/**
 * Every presented surface states the Machines (and the plugin selection) it needs, but each demand is held
 * once: the surface that asked first hosts it, the others only count, and a surviving one takes it over when
 * the host leaves. N widget bodies of one plugin therefore add no per-Machine demand or selection of their own.
 */
const sourceDemandRegistrants = new Map<string, symbol[]>();
const sourceDemandListeners = new Set<() => void>();

function notifySourceDemandHosts(): void {
    for (const listener of [...sourceDemandListeners]) listener();
}

/** Returns whether the key gained its first registrant (a new host). */
function registerSourceDemand(key: string, owner: symbol): boolean {
    const registrants = sourceDemandRegistrants.get(key) ?? [];
    sourceDemandRegistrants.set(key, [...registrants, owner]);
    return registrants.length === 0;
}

/** Returns whether the key's host left. */
function releaseSourceDemand(key: string, owner: symbol): boolean {
    const registrants = sourceDemandRegistrants.get(key) ?? [];
    const remaining = registrants.filter(registrant => registrant !== owner);
    if (remaining.length === 0) sourceDemandRegistrants.delete(key);
    else sourceDemandRegistrants.set(key, remaining);
    return registrants[0] === owner;
}

function useHostedDemands<T>(targets: readonly (readonly [string, T])[],
    question: 'presentation' | 'selectedOrigin'): readonly (readonly [string, T])[] {
    const [owner] = React.useState(() => Symbol('source-demand-surface'));
    const targetsKey = targets.map(([key]) => `${question}:${key}`).join('\n');
    // Registration follows the key set by difference, so a key the surface keeps keeps its place (and
    // its host): a changed target set never rotates the Machines it still shares with other surfaces.
    const registered = React.useRef<ReadonlySet<string>>(new Set());
    React.useLayoutEffect(() => {
        const next = new Set(targetsKey ? targetsKey.split('\n') : []);
        let hostChanged = false;
        for (const key of registered.current) if (!next.has(key)) hostChanged = releaseSourceDemand(key, owner) || hostChanged;
        for (const key of next) if (!registered.current.has(key)) hostChanged = registerSourceDemand(key, owner) || hostChanged;
        registered.current = next;
        if (hostChanged) notifySourceDemandHosts();
    }, [owner, targetsKey]);
    React.useLayoutEffect(() => () => {
        let released = false;
        for (const key of registered.current) released = releaseSourceDemand(key, owner) || released;
        registered.current = new Set();
        if (released) notifySourceDemandHosts();
    }, [owner]);
    const subscribe = React.useCallback((listener: () => void) => {
        sourceDemandListeners.add(listener);
        return () => { sourceDemandListeners.delete(listener); };
    }, []);
    const readHostedKeys = React.useCallback(() => targetsKey ? targetsKey.split('\n')
        .filter(key => sourceDemandRegistrants.get(key)?.[0] === owner).join('\n') : '', [owner, targetsKey]);
    const hostedKeys = React.useSyncExternalStore(subscribe, readHostedKeys, readHostedKeys);
    return React.useMemo(() => {
        const hosted = new Set(hostedKeys ? hostedKeys.split('\n') : []);
        return targets.filter(([key]) => hosted.has(`${question}:${key}`));
    }, [hostedKeys, question, targets]);
}
