import * as React from 'react';
import { PluginRightSidebarCountV1Schema, createPluginUiCountsValueV1Schema, type PluginUiHostApiSurfaceTargetV1, type PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { pluginUiResourceReferenceKey } from '@happier-dev/plugin-ui/advanced';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginContextualResourceState, resourceBindingKey, type PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolvePluginSidebarResourceContext } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import { resolvePluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { readSelectedPluginUiResourceCapability } from '@/sync/domains/plugins/ui/resourceCapability';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, readPluginUiContributionOrigin, resolvePluginUiExecutionDeclaration } from '@/sync/domains/plugins/ui/projectionUnion';
import { readPluginUiResourceProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { RightSidebarPluginTabDefinition } from './rightSidebarBuiltinTabs';
import type { PluginSurfaceDestinationCounts } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';

export type PluginRightSidebarLabelledCount = Readonly<{ field: string; label: string; count: number | null }>;

export type PluginRightSidebarCountDescriptor = Readonly<{
    tab: Pick<RightSidebarPluginTabDefinition, 'countResourceId' | 'counts' | 'badge' | 'disabledReason' | 'placement' | 'plugin'>;
    runtime: Readonly<{ pluginUiProjection: PluginUiProjectionModel | null; machineId: string | null;
        serverId: string | null; interactionEnabled: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>;
    sessionId?: string;
    projectId?: string;
    target?: PluginUiHostApiSurfaceTargetV1;
    launchInput?: PluginUiLaunchInputV1;
    mountInstanceKey?: string;
}>;

/** Declaration and current selected producer choose the read; containing rails supply no authority. */
export function resolvePluginRightSidebarCountBinding(input: PluginRightSidebarCountDescriptor): PluginContextualResourceBinding | null {
    const { tab } = input;
    const isApp = tab.placement.binding.targetKind === 'app';
    const accountLifetime = isApp ? captureActiveServerAccountScopeLifetime()
        : input.runtime.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : input.runtime.accountLifetime;
    const resourceId = tab.counts?.resourceId ?? tab.countResourceId;
    if (!accountLifetime?.isCurrent() || !resourceId || tab.disabledReason
        || tab.placement.availability.state !== 'available') return null;
    const projection = isApp ? readCurrentAppShellPluginUiProjection({ scope: accountLifetime.scope, declarationsOnly: true })
        : input.runtime.pluginUiProjection;
    const captured = readPluginUiResourceProjection(projection?.resourcesById, {
        pluginId: tab.plugin.pluginId, localId: resourceId,
    });
    const declaration = captured?.execution?.target === 'account' ? resolvePluginUiExecutionDeclaration(captured, {
        current: readPluginUiResourceProjection(readCurrentAppShellPluginUiProjection({
            scope: accountLifetime.scope, declarationsOnly: true,
        })?.resourcesById, { pluginId: tab.plugin.pluginId, localId: resourceId }),
    }) : captured;
    if (!declaration || declaration.contentType !== 'application/json' || !declaration.scope) return null;
    const context = declaration.scope === 'global' ? { kind: 'global' as const }
        : declaration.scope === 'session' && !isApp && tab.placement.binding.targetKind === 'session' && input.sessionId
            ? { kind: 'session' as const, sessionId: input.sessionId,
                ...(input.target?.kind === 'session' && input.target.sessionId === input.sessionId ? { target: input.target } : {}) }
            : declaration.scope === 'surface' ? resolvePluginSidebarResourceContext({ binding: tab.placement.binding,
                sessionId: input.sessionId, launchInput: input.launchInput,
                mountInstanceKey: input.mountInstanceKey, target: input.target }) : null;
    if (!context) return null;
    // Account Resources use the same native client/custody admission as mounted
    // surfaces. They have no Machine transport or Machine capability requirement.
    if (declaration.execution?.target === 'account') return declaration.occurrenceId ? {
        accountLifetime, pluginId: tab.plugin.pluginId, machineId: null,
        serverId: accountLifetime.scope.serverId, expectedCallerOccurrenceId: declaration.occurrenceId,
        accountResource: declaration, context,
    } : null;
    const executionPlacement = resolvePluginUiExecutionDeclaration(tab.placement, { machineResource: declaration });
    if (!executionPlacement) return null;
    const capability = readSelectedPluginUiResourceCapability(executionPlacement);
    if (!capability.readable || !capability.dynamic) return null;
    const authority = resolvePluginSurfaceLaunchAuthority({ placement: executionPlacement, accountLifetime,
        ...(isApp ? {} : { scoped: input.runtime }) });
    if (!authority?.machineId || !authority.serverId || !authority.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== authority.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    if (Object.hasOwn(declaration, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY) && !origin) return null;
    if (origin && (origin.phase !== 'current' || !origin.interactionEnabled
        || origin.machineId !== authority.machineId || origin.serverId !== authority.serverId)) return null;
    return { accountLifetime, pluginId: tab.plugin.pluginId, machineId: authority.machineId,
        serverId: authority.serverId, expectedCallerOccurrenceId: authority.occurrenceId, context };
}

/** A positive value proves content; only an entirely known zero record proves empty. */
export function pluginRightSidebarCountHasContent(count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]): boolean | null {
    if (!counts) return count === null ? null : count > 0;
    if (counts.some(item => item.count !== null && item.count > 0)) return true;
    return counts.every(item => item.count === 0) ? false : null;
}

/**
 * Shared text for the declaration's ordered count identities. Only non-zero counts are named: an unknown or zero
 * count says nothing, so a tab reads "Actions" rather than "Actions Running — · Failed —". Undefined when none is.
 */
export function formatPluginRightSidebarCount(count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]): string | undefined {
    if (!counts) return count === null || count <= 0 ? undefined : formatExactCount(count);
    const named = counts.flatMap(item => item.count !== null && item.count > 0 ? [`${item.label} ${formatExactCount(item.count)}`] : []);
    return named.length === 0 ? undefined : named.join(' · ');
}

function reconcileCounts(binding: PluginSurfaceDestinationCounts, values: Readonly<Record<string, number | null>> | null,
    previous?: readonly PluginRightSidebarLabelledCount[]): readonly PluginRightSidebarLabelledCount[] {
    const next = binding.items.map((item, index) => {
        const count = values?.[item.field] ?? null;
        const prior = previous?.[index];
        return prior?.field === item.field && prior.label === item.label && prior.count === count ? prior : Object.freeze({ ...item, count });
    });
    return previous?.length === next.length && next.every((item, index) => item === previous[index]) ? previous : Object.freeze(next);
}

export function readPluginRightSidebarCount(snapshot: PluginUiResourceSnapshot | null): number | null {
    if (!snapshot?.value || snapshot.error || snapshot.value.contentType !== 'application/json') return null;
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.value.bytes));
        const parsed = PluginRightSidebarCountV1Schema.safeParse(value);
        return parsed.success ? parsed.data.count : null;
    } catch { return null; }
}

/** Numeric badges and boolean placement subscribe independently to the same shared Resource entry. */
export function PluginRightSidebarCountState<T = number | null>(props: Readonly<{
    descriptor: PluginRightSidebarCountDescriptor;
    /** Preserve the exact entry while hidden chrome withdraws only its live demand. */
    active?: boolean;
    select?: (count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]) => T;
    children: (value: T, counts?: readonly PluginRightSidebarLabelledCount[]) => React.ReactNode;
}>): React.ReactElement {
    const countBinding = props.descriptor.tab.counts;
    const resourceId = countBinding?.resourceId ?? props.descriptor.tab.countResourceId;
    const valueSchema = React.useMemo(() => countBinding ? createPluginUiCountsValueV1Schema(countBinding) : null, [countBinding]);
    const isApp = Boolean(resourceId) && props.descriptor.tab.placement.binding.targetKind === 'app';
    const readDeclaration = React.useCallback(() => {
        const localId = resourceId;
        if (!isApp || !localId) return null;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return null;
        return readPluginUiResourceProjection(
            readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true })?.resourcesById,
            { pluginId: props.descriptor.tab.plugin.pluginId, localId },
        );
    }, [isApp, resourceId, props.descriptor.tab.plugin.pluginId]);
    const subscribe = React.useCallback((listener: () => void) => isApp
        ? subscribeCommittedAppShellPluginUiProjection(listener) : () => {}, [isApp]);
    // This exact declaration selector also observes the initial committed App
    // publication; unrelated resources leave the count mount unchanged.
    React.useSyncExternalStore(subscribe, readDeclaration, readDeclaration);
    const binding = resolvePluginRightSidebarCountBinding(props.descriptor);
    const decoded = React.useRef<Readonly<{ value: PluginUiResourceSnapshot['value']; binding: typeof countBinding; count: number | null;
        counts?: readonly PluginRightSidebarLabelledCount[] }> | null>(null);
    const select = (snapshot: PluginUiResourceSnapshot | null): T | number | null | readonly PluginRightSidebarLabelledCount[] => {
        // Decode each admitted byte value once; pending/subscription notifications carry no new payload.
        const value = snapshot?.error ? undefined : snapshot?.value;
        if (!decoded.current || decoded.current.value !== value || decoded.current.binding !== countBinding) {
            let values: Readonly<Record<string, number | null>> | null = null;
            if (value?.contentType === 'application/json' && valueSchema) {
                try {
                    const parsed = valueSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes)));
                    if (parsed.success) values = parsed.data;
                } catch { /* Invalid bytes make the whole atomic record unknown. */ }
            }
            decoded.current = { value, binding: countBinding, count: countBinding ? null : readPluginRightSidebarCount(snapshot),
                ...(countBinding ? { counts: reconcileCounts(countBinding, values, decoded.current?.counts) } : {}) };
        }
        return props.select ? props.select(decoded.current.count, decoded.current.counts) : decoded.current.counts ?? decoded.current.count;
    };
    if (!binding || !resourceId) {
        const value = select(null);
        return <>{props.children((props.select ? value : decoded.current?.count ?? null) as T, decoded.current?.counts)}</>;
    }
    return <PluginContextualResourceState binding={binding} resource={resourceId} active={props.active} select={select}>
        {value => props.children((props.select ? value : decoded.current?.count ?? null) as T, decoded.current?.counts)}
    </PluginContextualResourceState>;
}

export type PluginRightSidebarCountsItem = Readonly<{
    id: string;
    descriptor: PluginRightSidebarCountDescriptor;
    active?: boolean;
}>;

type CountSelectionScope = Readonly<{
    bindingKey: string | null;
    resourceKey: string | null;
    counts: PluginSurfaceDestinationCounts | null;
    accountLifetime: ServerAccountScopeLifetime | null;
}>;

function readCountSelectionScope(descriptor: PluginRightSidebarCountDescriptor): CountSelectionScope {
    const binding = resolvePluginRightSidebarCountBinding(descriptor);
    const resource = descriptor.tab.counts?.resourceId ?? descriptor.tab.countResourceId;
    return {
        bindingKey: binding ? resourceBindingKey(binding) : null,
        resourceKey: resource ? pluginUiResourceReferenceKey(resource, descriptor.tab.plugin.pluginId) : null,
        counts: descriptor.tab.counts ?? null,
        accountLifetime: binding?.accountLifetime ?? null,
    };
}

function sameCountSelectionScope(left: CountSelectionScope, right: CountSelectionScope): boolean {
    return left.bindingKey === right.bindingKey && left.resourceKey === right.resourceKey
        && sameStrictJsonValue(left.counts, right.counts);
}

function isCountSelectionCurrent(scope: CountSelectionScope): boolean {
    return scope.accountLifetime?.isCurrent() !== false;
}

function CountSelectionPublisher<T>(props: Readonly<{
    id: string;
    value: T;
    scope: CountSelectionScope;
    publish: (id: string, scope: CountSelectionScope, value: T) => void;
}>): null {
    React.useLayoutEffect(() => { props.publish(props.id, props.scope, props.value); }, [props.id, props.scope, props.value, props.publish]);
    return null;
}

function CountActor<T>(props: Readonly<{
    item: PluginRightSidebarCountsItem;
    scope: CountSelectionScope;
    select?: (count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]) => T;
    publish: (id: string, scope: CountSelectionScope, value: T) => void;
    forget: (id: string) => void;
}>): React.ReactElement {
    const { id } = props.item;
    React.useLayoutEffect(() => () => { props.forget(id); }, [id, props.forget]);
    return <PluginRightSidebarCountState descriptor={props.item.descriptor} active={props.item.active} select={props.select}>
        {value => <CountSelectionPublisher id={id} scope={props.scope} value={value} publish={props.publish} />}
    </PluginRightSidebarCountState>;
}

/**
 * Keyed siblings retain each count's existing Resource lifecycle when a catalog
 * inserts, removes or reorders a neighbor. This map holds selected presentation
 * values only; each actor still uses the single count decoder and Resource owner.
 */
export function PluginRightSidebarCountsState<T = number | null>(props: Readonly<{
    items: readonly PluginRightSidebarCountsItem[];
    select?: (count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]) => T;
    children: (values: ReadonlyMap<string, T>) => React.ReactNode;
}>): React.ReactElement {
    const [selections, setSelections] = React.useState<ReadonlyMap<string, Readonly<{ scope: CountSelectionScope; value: T }>>>(() => new Map());
    const publish = React.useCallback((id: string, scope: CountSelectionScope, value: T) => {
        setSelections(previous => {
            const prior = previous.get(id);
            return prior && isCountSelectionCurrent(prior.scope) && sameCountSelectionScope(prior.scope, scope) && Object.is(prior.value, value)
                ? previous : new Map(previous).set(id, { scope, value });
        });
    }, []);
    const forget = React.useCallback((id: string) => {
        setSelections(previous => {
            if (!previous.has(id)) return previous;
            const next = new Map(previous);
            next.delete(id);
            return next;
        });
    }, []);
    const scopedItems = props.items.map(item => ({ item, scope: readCountSelectionScope(item.descriptor) }));
    const scopes = new Map(scopedItems.map(({ item, scope }) => [item.id, scope] as const));
    // This is only a view of the selected presentation state, not Resource data.
    const values = React.useMemo(() => new Map([...selections].map(([id, selection]) => [id, selection.value] as const)), [selections]);
    // Match ResourceState's render-time binding/currentness fence, including a
    // changed declared decoder. Never lend old selections until layout effects run.
    const admitted = [...selections].filter(([id, selection]) => {
        const scope = scopes.get(id);
        return scope && isCountSelectionCurrent(scope) && isCountSelectionCurrent(selection.scope)
            && sameCountSelectionScope(selection.scope, scope);
    });
    const current = admitted.length === selections.size ? values
        : new Map(admitted.map(([id, selection]) => [id, selection.value] as const));
    return <>
        {scopedItems.map(({ item, scope }) => <CountActor key={item.id} item={item} scope={scope} select={props.select} publish={publish} forget={forget} />)}
        {props.children(current)}
    </>;
}
