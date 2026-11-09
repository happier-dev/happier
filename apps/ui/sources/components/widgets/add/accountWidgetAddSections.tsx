import * as React from 'react';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { MACHINE_BUILTIN_WIDGET_IDS_V1, PROJECT_BUILTIN_WIDGET_IDS_V1, SESSION_COMPANION_BUILTIN_ITEM_IDS, USAGE_BUILTIN_WIDGET_IDS_V1, normalizeWidgetSizeForSurfaceV1, supportsWidgetGroupsV1, type WidgetLayoutFragmentSummaryV1, type WidgetProjectAreaV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useHomeWidgetCandidates } from '@/components/hub/layout/useHomeWidgetCandidates';
import { useYourWidgetCandidatesState, type AccountInventoryStatus } from '@/components/widgets/definitions/useYourWidgetCandidates';
import { useYourWidgetLayoutFragments } from '@/components/widgets/definitions/useYourWidgetLayoutFragments';
import { runAddWidgetLayoutFragmentCommandV1 } from '@/components/widgets/definitions/widgetLayoutFragmentCommands';
import { buildWidgetGroupFragmentEntry, WidgetGroupFragmentPreview } from '@/components/widgets/group/widgetGroupFragmentSetup';
import { useDeviceType } from '@/utils/platform/responsive';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import {
    buildWidgetCandidateSetup,
    countWidgetInstances,
    groupWidgetCandidatesByPlugin,
    isConfigurableWidgetCandidate,
    partitionWidgetCandidatesBySource,
    selectHostableWidgetCandidates,
    runAcknowledgedWidgetSetupCommand,
    runWidgetSetupCommand,
    widgetDefinitionOfCandidate,
    widgetProvidedContext,
    type WidgetSurfaceContext,
    type WidgetSetupCommandResult,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import type { WidgetAddEntry, WidgetAddSection } from './widgetAddModel';
import type { WidgetSetupDraft } from './widgetSetupModel';

/**
 * Home and a WorkBoard have no Session or page of their own: a Session input is chosen, never
 * borrowed. A personal area (a plugin page, a Project aside) passes the slots it fills instead.
 */
const NO_CONTEXT: WidgetSurfaceContext = Object.freeze({});
const NO_PROVIDED_CONTEXT = Object.freeze({});

/** What a personal surface says about its copies and where an add goes ("2 on Home", "Add to Home"). */
export type AccountWidgetSurfaceLabels = Readonly<{
    count: (count: number) => string;
    submit: string;
}>;

export type AccountWidgetAddInput = Readonly<{
    candidates: readonly WidgetCandidate[];
    /** The surface's current copies; the gallery counts them by definition. */
    instances: readonly WidgetInstanceV1[];
    /** The surface's one add intent: rejects on refusal or returns its explicit acknowledged step result. */
    addInstance: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<WidgetSetupCommandResult>;
    scope: WidgetSurfaceRefV1 | null;
    labels: AccountWidgetSurfaceLabels;
    /** What the surface fills on its own ("This page", "This checkout"); none on Home or a WorkBoard. */
    context?: WidgetSurfaceContext;
    renderSetupPreview?: (candidate: WidgetCandidate, preview: Readonly<{ draft: WidgetSetupDraft }>) => React.ReactNode;
    /** Saved groups (A7), on surfaces that hold groups: each adds one copy of the whole group. */
    fragments?: readonly WidgetLayoutFragmentSummaryV1[];
    fragmentActions?: (fragment: WidgetLayoutFragmentSummaryV1) => ItemAction[];
    addGroup?: (fragment: WidgetLayoutFragmentSummaryV1, draft: WidgetSetupDraft) => Promise<WidgetSetupCommandResult>;
    /** A saved group's live preview in its pane. */
    renderGroupPreview?: (fragment: WidgetLayoutFragmentSummaryV1, draft: WidgetSetupDraft, waiting?: string) => React.ReactNode;
}>;

/**
 * What a personal surface's Add offers (lab `widget-add` wsplit A): Happier's own widgets (Built in),
 * each plugin's widgets under its name, and Your widgets, counted by the copies already there. Every
 * widget is added from its pane — inputs first, its live body at the chosen size, then Add — and a
 * widget without inputs that is already here stays Added. Every add is the surface's one add intent,
 * the same operation `widgets.item.add` performs for an agent.
 */
/**
 * Happier's built-in families that read as one group of their own (plan 60 AGW-14, lab `rw` AD; usage
 * lab `d2edit-G`): Machines, Usage, the Project widgets and the Session details widgets (Session summary,
 * Plan, Changes, Local services: each needs a chosen Session). The family matching the presenting
 * surface leads (Project, Machines or Usage); other families keep this order, including on Account Home.
 */
const BUILTIN_WIDGET_FAMILIES = [
    { id: 'machines', ids: new Set<string>(MACHINE_BUILTIN_WIDGET_IDS_V1), ownerKind: 'corePage', pageId: 'machines', title: () => t('machines.widgets.machine_fleet') },
    { id: 'usage', ids: new Set<string>(USAGE_BUILTIN_WIDGET_IDS_V1), ownerKind: 'corePage', pageId: 'usage', title: () => t('usage.board.page.title') },
    { id: 'projects', ids: new Set<string>(PROJECT_BUILTIN_WIDGET_IDS_V1), ownerKind: 'project', pageId: null, title: () => t('tabs.projects') },
    { id: 'session', ids: new Set<string>(SESSION_COMPANION_BUILTIN_ITEM_IDS), ownerKind: null, pageId: null, title: () => t('widgetAdd.sessionDetails') },
] as const;
type BuiltinWidgetFamily = (typeof BUILTIN_WIDGET_FAMILIES)[number];
function builtinWidgetFamilyOf(candidate: WidgetCandidate): BuiltinWidgetFamily | null {
    const definition = candidate.definition;
    return definition?.kind === 'builtin' ? BUILTIN_WIDGET_FAMILIES.find(family => family.ids.has(definition.id)) ?? null : null;
}

export function buildAccountWidgetAddSections(input: AccountWidgetAddInput): readonly WidgetAddSection[] {
    const context = input.context ?? NO_CONTEXT;
    const entry = (candidate: WidgetCandidate): WidgetAddEntry => {
        const definition = widgetDefinitionOfCandidate(candidate);
        const copies = countWidgetInstances(input.instances, definition);
        const configurable = isConfigurableWidgetCandidate(candidate);
        let instanceId: string | null = null;
        let pending: Promise<WidgetSetupCommandResult> | null = null;
        const add = (bindings: WidgetInputBindingsV1, size?: WidgetSizeV1) => {
            if (pending) return pending;
            instanceId ??= randomUUID();
            const instance: WidgetInstanceV1 = { v: 1, id: instanceId, definition, bindings };
            pending = Promise.resolve().then(() => input.addInstance(instance,
                input.scope ? normalizeWidgetSizeForSurfaceV1(input.scope.owner.kind, size, candidate.sizeDeclaration) : undefined))
                .then(result => {
                    // Approval has custody too. Only a resolved successful invocation
                    // permits an intentional Add another to allocate a different copy.
                    if (!result || result.ok) instanceId = null;
                    return result;
                }).finally(() => { pending = null; });
            return pending;
        };
        const renderSetupPreview = input.renderSetupPreview;
        const setup = buildWidgetCandidateSetup({
            candidate, context, audience: 'personal', mode: { kind: 'add', submitLabel: input.labels.submit },
            submit: (draft) => runWidgetSetupCommand(() => add(draft.bindings, draft.size), t('widgetAdd.addFailed')),
            scope: input.scope,
            ...(renderSetupPreview ? { renderPreview: (preview) => renderSetupPreview(candidate, preview) } : {}),
        });
        return {
            id: `plugin-${candidate.key}`,
            title: candidate.title,
            // Its sections already name where it comes from, so the row's line is its purpose.
            // A purpose that only repeats the name says nothing: the row then shows the name alone.
            ...(candidate.description && candidate.description.trim() !== candidate.title.trim() ? { subtitle: candidate.description } : {}),
            icon: candidate.icon,
            ...(configurable
                ? (copies > 0 ? { count: input.labels.count(copies) } : {})
                : { added: copies > 0 }),
            setup: () => setup,
        };
    };
    const widgets = partitionWidgetCandidatesBySource(input.scope ? selectHostableWidgetCandidates(input.candidates, input.scope.owner.kind) : input.candidates);
    const addGroup = input.addGroup;
    const groups = addGroup ? (input.fragments ?? []).map(fragment => ({ ...buildWidgetGroupFragmentEntry({
        fragment, candidates: input.candidates, scope: input.scope, context, submitLabel: input.labels.submit,
        add: (saved, draft) => runWidgetSetupCommand(() => addGroup({ ...saved, group: {
            ...saved.group, context: draft.bindings, ...(draft.width ? { width: draft.width } : {}),
        } }, draft), t('widgetAdd.addFailed')),
        renderGroupPreview: input.renderGroupPreview ?? (() => null),
    }), ...(input.fragmentActions ? { actions: input.fragmentActions(fragment) } : {}) })) : [];
    const yours = [...widgets.yours.map(entry), ...groups];
    const owner = input.scope?.owner;
    const ownScope = (family: BuiltinWidgetFamily) => owner !== undefined && family.ownerKind === owner.kind
        && (owner.kind !== 'corePage' || family.pageId === owner.pageId);
    const families = [...BUILTIN_WIDGET_FAMILIES].sort((a, b) => Number(ownScope(b)) - Number(ownScope(a)))
        .map(family => ({ family, candidates: widgets.builtIn.filter(candidate => builtinWidgetFamilyOf(candidate) === family) }))
        .filter(({ candidates }) => candidates.length > 0);
    const otherBuiltIns = widgets.builtIn.filter(candidate => builtinWidgetFamilyOf(candidate) === null);
    return [
        ...families.map(({ family, candidates }) => ({ id: `builtins:${family.id}`, title: family.title(),
            hint: t('widgetAdd.builtIn').toLocaleLowerCase(), family: true as const, entries: candidates.map(entry) })),
        { id: 'builtins', title: t('widgetAdd.builtIn'), entries: otherBuiltIns.map(entry) },
        ...groupWidgetCandidatesByPlugin(widgets.fromPlugins).map((group) => ({
            id: `plugin:${group.id}`, title: group.title, hint: t('widgetAdd.pluginTag'), pluginId: group.id, entries: group.candidates.map(entry),
        })),
        // Definitions the person or their agents made (lab dbind G), only when there are any.
        ...(yours.length > 0 ? [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), hint: t('widgetDefinition.yourWidgetsHint'),
            entries: yours }] : []),
    ];
}

/**
 * One saved-inventory state projection for every Gallery: only an unresolved section waits, and a
 * refused read offers Retry rather than continuing to claim it is loading.
 */
export function useYourWidgetPendingSections(status: AccountInventoryStatus, retry: () => void): readonly (
    Pick<WidgetAddSection, 'id' | 'title'> & Readonly<{ retry?: () => void }>
)[] {
    return React.useMemo(() => status === 'ready' ? []
        : [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), ...(status === 'failed' ? { retry } : {}) }], [retry, status]);
}

/**
 * The live sections for a personal surface's Add: the app shell's widget candidates and the selected
 * widget's exact-authority preview. Mount it only while the Add is open, so a closed control reads
 * and previews nothing.
 */
export function useAccountWidgetAddSections(input: Readonly<{
    scope: WidgetSurfaceRefV1 | null;
    instances: readonly WidgetInstanceV1[];
    addInstance: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<WidgetSetupCommandResult>;
    labels: AccountWidgetSurfaceLabels;
    context?: WidgetSurfaceContext;
    /** A Project area places a saved group in its own column. */
    area?: WidgetProjectAreaV1;
    testID: string;
}>): Readonly<{
    sections: readonly WidgetAddSection[];
    /** Aggregate saved-inventory state retained for callers migrating to pendingSections. */
    loading: boolean;
    /** Local sections are ready independently; only these remote sections are still unresolved. */
    pendingSections: readonly (Pick<WidgetAddSection, 'id' | 'title'> & Readonly<{ retry?: () => void }>)[];
}> {
    const appRuntime = useAppShellPluginUiProjection();
    const localize = usePluginLocalizedTextResolver({ projection: appRuntime.pluginUiProjection });
    const installed = useHomeWidgetCandidates(localize, input.context?.projectContext?.policyContext);
    const { scope, instances, addInstance, labels, context, testID } = input;
    const { candidates: yours, status: yoursStatus, retry: retryYours } = useYourWidgetCandidatesState(scope ? { serverId: scope.serverId, accountId: scope.accountId } : null, appRuntime.pluginUiProjection);
    const candidates = React.useMemo(() => (yours.length > 0 ? [...installed, ...yours] : installed), [installed, yours]);
    const phone = useDeviceType() === 'phone';
    // Saved groups only where groups can be placed (Home, Project, plugin and core-page areas).
    const groupCapable = scope !== null && supportsWidgetGroupsV1(scope.owner.kind);
    const { fragments, status: fragmentsStatus, retry: retryFragments, actionsFor: fragmentActions } = useYourWidgetLayoutFragments(groupCapable ? { serverId: scope.serverId, accountId: scope.accountId } : null);
    const area = input.area;
    const addGroup = React.useCallback(async (fragment: WidgetLayoutFragmentSummaryV1) => {
        if (!scope) throw new Error('widget_area_unavailable');
        return runAcknowledgedWidgetSetupCommand(() => runAddWidgetLayoutFragmentCommandV1(fragment.group, scope,
            { name: fragment.name, ...(area ? { area } : {}) }), t('widgetAdd.addFailed'));
    }, [area, scope]);
    const sections = React.useMemo(() => buildAccountWidgetAddSections({
        candidates,
        instances,
        addInstance,
        scope,
        labels,
        ...(context ? { context } : {}),
        ...(groupCapable && scope ? { fragments, fragmentActions, addGroup, renderGroupPreview: (fragment: WidgetLayoutFragmentSummaryV1, draft: WidgetSetupDraft, waiting?: string) => (
            <WidgetGroupFragmentPreview fragment={fragment} draft={draft} candidates={candidates} scope={scope} phone={phone} waiting={waiting}
                providedContext={context ? widgetProvidedContext(context) : NO_PROVIDED_CONTEXT} projectContext={context?.projectContext} testID={`${testID}.groupPreview.${fragment.artifactId}`} />
        ) } : {}),
        ...(scope ? {
            renderSetupPreview: (candidate: WidgetCandidate, preview: Readonly<{ draft: WidgetSetupDraft }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={context ? widgetProvidedContext(context) : NO_PROVIDED_CONTEXT}
                    projectContext={context?.projectContext}
                    candidate={candidate}
                    draft={preview.draft}
                    testID={`${testID}.setupPreview.${candidate.key}`}
                />
            ),
        } : {}),
    }), [addGroup, addInstance, appRuntime, candidates, context, fragmentActions, fragments, groupCapable, instances, labels, phone, scope, testID]);
    const statuses = [yoursStatus, ...(groupCapable ? [fragmentsStatus] : [])];
    const loading = statuses.includes('loading');
    const failed = statuses.includes('failed');
    const retry = React.useCallback(() => {
        if (yoursStatus === 'failed') retryYours();
        if (fragmentsStatus === 'failed') retryFragments();
    }, [fragmentsStatus, retryFragments, retryYours, yoursStatus]);
    const pendingSections = useYourWidgetPendingSections(loading ? 'loading' : failed ? 'failed' : 'ready', retry);
    return { sections, loading, pendingSections };
}
