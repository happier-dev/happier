import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import { TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1 } from '@happier-dev/triage-protocol/v1';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { resolveComposerSuggestionKind } from '@/components/autocomplete/composerSuggestionKinds';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { composerControlKey } from '@/components/plugins/actions/pluginContributedActionComposerChips';
import { usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    compareOrderedComposerContributions,
    useComposerScopePluginPresentation,
    type ComposerScopePluginPresentation,
} from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { PLUGIN_COMPOSER_PROJECTION_SECTIONS, readPluginComposerProjectionDemandTargets,
    usePluginExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

type DiscussionComposer = Extract<ComposerRefV1, { kind: 'discussion' }>;
type Slots = Readonly<{
    extraActionChips: readonly AgentInputExtraActionChip[];
    beforeComposer: React.ReactNode;
    afterComposer: React.ReactNode;
    statusRegions: ComposerScopePluginPresentation['statusRegions'];
    suggestReferences(query: string, signal: AbortSignal): Promise<AutocompleteSuggestion[]>;
}>;
type Contributor = Readonly<{ id: string; pluginId: string }>;
type PresentationSlots = Readonly<{
    contributor: Contributor;
    composerKey: string;
    lifetime: ServerAccountScopeLifetime;
    presentation: ComposerScopePluginPresentation;
    suggestReferences: Slots['suggestReferences'];
}>;
type SharedProps = Readonly<{
    composer: DiscussionComposer;
    lifetime: ServerAccountScopeLifetime;
    enabled: boolean;
}>;
const APP_TARGET = Object.freeze({ kind: 'app' as const });
const GLOBAL_RESOURCE_CONTEXT = Object.freeze({ kind: 'global' as const });

/** One Account declaration union; each plugin borrows its existing Administration-selected producer. */
export function DiscussionComposerPluginContributions(props: Omit<SharedProps, 'composer'> & Readonly<{
    composer: DiscussionComposer | null;
    children(slots: Slots): React.ReactElement;
}>): React.ReactElement {
    const shell = useAppShellPluginUiProjection();
    const active = useLayoutPresentationActive();
    const projection = shell.pluginUiProjection;
    const presented = props.composer !== null && props.enabled && active && props.lifetime.isCurrent();
    const availability = usePluginAccountAvailabilityReader(props.lifetime.scope, undefined, { enabled: presented });
    const installed = availability?.readInstalledPlugins() ?? null;
    const declarationTargets = React.useMemo(() => presented
        ? readPluginComposerProjectionDemandTargets(installed, 'discussion') : [], [installed, presented]);
    // Lift only rendered slot values. Declaration, origin, document and
    // transaction decisions remain with their incumbent owners below.
    const [slots, setSlots] = React.useState<ReadonlyMap<string, PresentationSlots>>(() => new Map());
    const publish = React.useCallback((value: PresentationSlots, remove = false) => {
        setSlots(previous => {
            const current = previous.get(value.contributor.pluginId);
            if (remove ? current !== value : current === value) return previous;
            const next = new Map(previous);
            if (remove) next.delete(value.contributor.pluginId);
            else next.set(value.contributor.pluginId, value);
            return next;
        });
    }, []);
    const contributors = React.useMemo(() => {
        const byPlugin = new Map<string, Contributor>();
        if (projection && presented) {
            for (const entry of [...Object.values(projection.composerControlsById), ...Object.values(projection.composerRegionsById),
                ...Object.values(projection.composerReferencesById)]) {
                if ('scopes' in entry.definition && entry.definition.scopes && !entry.definition.scopes.includes('discussion')) continue;
                if (byPlugin.has(entry.identity.pluginId)) continue;
                byPlugin.set(entry.identity.pluginId, { id: entry.id, pluginId: entry.identity.pluginId });
            }
        }
        return [...byPlugin.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    }, [presented, projection]);
    const composerKey = props.composer ? composerRefV1Key(props.composer) : null;
    const admittedSlots = React.useMemo(() => contributors.flatMap(contributor => {
        const value = slots.get(contributor.pluginId);
        return value && value.contributor.id === contributor.id && value.composerKey === composerKey
            && value.lifetime === props.lifetime && props.lifetime.isCurrent() ? [value] : [];
    }), [composerKey, contributors, props.lifetime, slots]);
    const suggestReferences = React.useCallback<Slots['suggestReferences']>(async (query, signal) => {
        const rows = await Promise.all(admittedSlots.map(value => value.suggestReferences(query, signal)));
        return signal.aborted || !props.lifetime.isCurrent() ? []
            : rows.flat().slice(0, resolveComposerSuggestionKind('composerReference').limit);
    }, [admittedSlots, props.lifetime]);
    const render = () => {
        const controls = new Map(Object.values(projection?.composerControlsById ?? {}).map(entry => [composerControlKey(entry), entry]));
        const chips = admittedSlots.flatMap(({ presentation }) => presentation.extraActionChips.flatMap(chip => {
            const contribution = controls.get(chip.key);
            return contribution ? [{ contribution, chip }] : [];
        })).sort((left, right) => compareOrderedComposerContributions(left.contribution, right.contribution));
        const regions = admittedSlots.flatMap(({ presentation }) => presentation.composerRegions.map(contribution => ({
            contribution, render: () => presentation.renderComposerRegion(contribution),
        }))).sort((left, right) => compareOrderedComposerContributions(left.contribution, right.contribution));
        return props.children({
            extraActionChips: chips.map(entry => entry.chip),
            beforeComposer: regions.filter(entry => entry.contribution.definition.placement === 'beforeComposer')
                .map(entry => <React.Fragment key={entry.contribution.id}>{entry.render()}</React.Fragment>),
            afterComposer: regions.filter(entry => entry.contribution.definition.placement === 'afterComposer')
                .map(entry => <React.Fragment key={entry.contribution.id}>{entry.render()}</React.Fragment>),
            statusRegions: regions.filter(entry => entry.contribution.definition.placement === 'statusStrip')
                .map(entry => ({ emphasis: entry.contribution.definition.emphasis,
                    node: <React.Fragment key={entry.contribution.id}>{entry.render()}</React.Fragment> })),
            suggestReferences,
        });
    };
    return <>
        {declarationTargets.map(target => <DiscussionComposerDeclarationDemand key={JSON.stringify([target.serverIdentityId, target.machineId])}
            target={target} lifetime={props.lifetime} />)}
        {projection && props.composer ? contributors.map(contributor => <ContributorSlots key={contributor.pluginId}
            composer={props.composer!} lifetime={props.lifetime} enabled={presented}
            projection={projection} contributor={contributor} onPresentation={publish} />) : null}
        {render()}
    </>;
}

/** The presented Composer requests discovery before executable supplies exist. */
const DiscussionComposerDeclarationDemand = React.memo(function DiscussionComposerDeclarationDemand(props: Readonly<{
    target: MachineAdministrationTargetV1;
    lifetime: ServerAccountScopeLifetime;
}>): null {
    usePluginExecutionOriginProjectionDemand(props.target, { accountLifetime: props.lifetime,
        sections: PLUGIN_COMPOSER_PROJECTION_SECTIONS, observe: false });
    return null;
});

/**
 * Stable sibling leaves preserve each plugin's UI across unrelated catalog
 * changes. Slot publication re-renders the parent; unchanged inputs must not
 * recursively re-evaluate and republish the same contributor's presentation.
 */
const ContributorSlots = React.memo(function ContributorSlots(props: SharedProps & Readonly<{
    projection: PluginUiProjectionModel;
    contributor: Contributor;
    onPresentation(value: PresentationSlots, remove?: boolean): void;
}>): null {
    const contributor = props.contributor;
    const presentationEntry = props.projection.composerControlsById[contributor.id] ?? props.projection.composerRegionsById[contributor.id];
    const entry = presentationEntry ?? props.projection.composerReferencesById[contributor.id];
    const origin = usePluginSurfaceExecutionOrigin({ pluginId: contributor.pluginId, entry,
        projection: props.projection, enabled: props.enabled, includeMachineCandidates: false });
    const supply = origin.selectedSupply;
    const enabled = props.enabled && props.lifetime.isCurrent() && origin.selection.canExecute;
    const daemon = useDaemonMergedProjectionInputs({ machineId: supply?.machineId ?? null,
        serverId: supply?.serverId, accountLifetime: props.lifetime,
        sections: PLUGIN_COMPOSER_PROJECTION_SECTIONS, enabled, load: enabled && Boolean(presentationEntry) });
    const suggestReferences = React.useCallback<Slots['suggestReferences']>(async (query, signal) => {
        const current = () => enabled && props.lifetime.isCurrent() && origin.isExecutionOriginCurrent() && !signal.aborted;
        if (!current() || !supply?.machineId) return [];
        // The cache's existing acquisition owner shares in-flight work with
        // rendered controls; reference-only plugins stay cold until this query.
        const loaded = await loadDaemonMergedProjectionCacheEntry({ machineId: supply.machineId,
            serverId: supply.serverId, accountLifetime: props.lifetime,
            sections: PLUGIN_COMPOSER_PROJECTION_SECTIONS, reuseFreshReady: true, signal });
        if (!current() || loaded?.kind !== 'ready' || !loaded.inputs.pluginProjectionV2
            || loaded.inputs.pluginProjectionById[contributor.pluginId]?.occurrenceId !== supply.occurrenceId) return [];
        return getSuggestions(null, query, { kinds: ['composerReference'], signal, composerReferenceHost: {
            machineId: supply.machineId, serverId: supply.serverId,
            projection: loaded.inputs.pluginProjectionV2, pluginUiProjection: loaded.inputs.pluginUiProjection,
            contributorPluginId: contributor.pluginId, isCurrent: current,
        } });
    }, [contributor.pluginId, enabled, origin.isExecutionOriginCurrent, props.lifetime, supply]);
    // The Account union selects a producer, not any later installation that
    // happens to occupy the same Machine's daemon cache.
    const matchesSelectedSupply = Boolean(supply?.occurrenceId
        && daemon.inputs?.pluginProjectionById[contributor.pluginId]?.occurrenceId === supply.occurrenceId);
    const isCurrent = React.useCallback(() => enabled && matchesSelectedSupply && props.lifetime.isCurrent()
        && origin.isExecutionOriginCurrent(), [enabled, matchesSelectedSupply, origin.isExecutionOriginCurrent, props.lifetime]);
    const presentation = useComposerScopePluginPresentation({
        composer: props.composer, contributorPluginId: contributor.pluginId,
        physicalTarget: APP_TARGET, resourceContext: GLOBAL_RESOURCE_CONTEXT,
        machineId: supply?.machineId ?? null, serverId: supply?.serverId,
        projectionPhase: enabled ? daemon.phase : 'idle', projectionInputs: daemon.inputs,
        accountLifetime: props.lifetime, isScopeCurrent: isCurrent,
        attachmentsEnabled: contributor.pluginId === TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1.pluginId, includeSessionActions: false,
    });
    const value = React.useMemo<PresentationSlots>(() => ({ contributor, lifetime: props.lifetime,
        composerKey: composerRefV1Key(props.composer), presentation, suggestReferences,
    }), [contributor, presentation, props.composer, props.lifetime, suggestReferences]);
    React.useLayoutEffect(() => {
        props.onPresentation(value);
        return () => props.onPresentation(value, true);
    }, [props.onPresentation, value]);
    return null;
});
