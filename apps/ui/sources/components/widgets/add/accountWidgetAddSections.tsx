import * as React from 'react';
import type { WidgetInputBindingsV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useHomeWidgetCandidates } from '@/components/hub/layout/useHomeWidgetCandidates';
import { useYourWidgetCandidates } from '@/components/widgets/definitions/useYourWidgetCandidates';
import {
    buildWidgetCandidateSetup,
    countWidgetInstances,
    isConfigurableWidgetCandidate,
    partitionWidgetCandidatesBySource,
    runWidgetSetupCommand,
    widgetDefinitionOfCandidate,
    widgetProvidedContext,
    widgetSetupFieldsForCandidate,
    type WidgetSurfaceContext,
    type WidgetSetupCommandResult,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import type { WidgetAddEntry, WidgetAddSection } from './widgetAddModel';
import { proposeWidgetSetupDraft } from './widgetSetupModel';

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
    fromPluginsHint: string;
}>;

export type AccountWidgetAddInput = Readonly<{
    candidates: readonly WidgetCandidate[];
    /** The surface's current copies; the gallery counts them by definition. */
    instances: readonly WidgetInstanceV1[];
    /** The surface's one add intent: rejects on refusal or returns its explicit acknowledged step result. */
    addInstance: (instance: WidgetInstanceV1) => Promise<WidgetSetupCommandResult>;
    scope: WidgetSurfaceRefV1 | null;
    labels: AccountWidgetSurfaceLabels;
    /** What the surface fills on its own ("This page", "This checkout"); none on Home or a WorkBoard. */
    context?: WidgetSurfaceContext;
    renderTilePreview?: (candidate: WidgetCandidate) => React.ReactNode;
    renderSetupPreview?: (candidate: WidgetCandidate, preview: Readonly<{ draft: { bindings: WidgetInputBindingsV1 } }>) => React.ReactNode;
}>;

/**
 * What a personal surface's gallery offers (lab `dashboards` dbind G, L1): Happier's own widgets
 * (Built in) and every widget a plugin offers, counted by the copies already there. A pick with
 * inputs opens Set up only when something is missing; a widget with no inputs adds at once and stays
 * Added. Every add is the surface's one add intent — the same operation `widgets.instance.add`
 * performs for an agent.
 */
export function buildAccountWidgetAddSections(input: AccountWidgetAddInput): readonly WidgetAddSection[] {
    const context = input.context ?? NO_CONTEXT;
    const entry = (candidate: WidgetCandidate): WidgetAddEntry => {
        const definition = widgetDefinitionOfCandidate(candidate);
        const copies = countWidgetInstances(input.instances, definition);
        const configurable = isConfigurableWidgetCandidate(candidate);
        const add = (bindings: WidgetInputBindingsV1) => input.addInstance({ v: 1, id: randomUUID(), definition, bindings });
        const renderTilePreview = input.renderTilePreview;
        const renderSetupPreview = input.renderSetupPreview;
        return {
            id: `plugin-${candidate.key}`,
            title: candidate.title,
            subtitle: candidate.sharedPluginName && candidate.surface ? `${candidate.pluginName} (${candidate.surface.pluginId})` : candidate.pluginName,
            icon: candidate.icon,
            ...(configurable
                ? (copies > 0 ? { count: input.labels.count(copies) } : {})
                : { added: copies > 0 }),
            // App widgets draw their real body in the tile; a configurable or Session widget needs its
            // inputs first, so its tile keeps the glyph.
            ...(renderTilePreview && candidate.target === 'app' && !configurable ? { renderPreview: () => renderTilePreview(candidate) } : {}),
            ...(configurable ? {
                setup: () => buildWidgetCandidateSetup({
                    candidate,
                    context,
                    audience: 'personal',
                    mode: { kind: 'add', submitLabel: input.labels.submit },
                    submit: (draft) => runWidgetSetupCommand(() => add(draft.bindings), t('widgetAdd.addFailed')),
                    scope: input.scope,
                    ...(renderSetupPreview ? { renderPreview: (preview) => renderSetupPreview(candidate, preview) } : {}),
                }),
            } : {}),
            onPick: () => { void add(proposeWidgetSetupDraft(widgetSetupFieldsForCandidate(candidate, context, 'personal')).bindings).catch(() => {}); },
        };
    };
    const widgets = partitionWidgetCandidatesBySource(input.candidates);
    return [
        { id: 'builtins', title: t('widgetAdd.builtIn'), kind: 'preview', entries: widgets.builtIn.map(entry) },
        { id: 'plugins', title: t('widgetAdd.fromPlugins'), hint: input.labels.fromPluginsHint, kind: 'preview', entries: widgets.fromPlugins.map(entry) },
        // Definitions the person or their agents made (lab dbind G), only when there are any.
        ...(widgets.yours.length > 0 ? [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), hint: t('widgetDefinition.yourWidgetsHint'),
            kind: 'preview' as const, entries: widgets.yours.map(entry) }] : []),
    ];
}

/**
 * The live sections for a personal surface's Add: the app shell's widget candidates, real tile
 * bodies and the Set up step's exact-authority preview. Mount it only while the Add is open, so a
 * closed control reads and previews nothing.
 */
export function useAccountWidgetAddSections(input: Readonly<{
    scope: WidgetSurfaceRefV1 | null;
    instances: readonly WidgetInstanceV1[];
    addInstance: (instance: WidgetInstanceV1) => Promise<WidgetSetupCommandResult>;
    labels: AccountWidgetSurfaceLabels;
    context?: WidgetSurfaceContext;
    testID: string;
}>): readonly WidgetAddSection[] {
    const installed = useHomeWidgetCandidates();
    const appRuntime = useAppShellPluginUiProjection();
    const { scope, instances, addInstance, labels, context, testID } = input;
    const yours = useYourWidgetCandidates(scope ? { serverId: scope.serverId, accountId: scope.accountId } : null, appRuntime.pluginUiProjection);
    const candidates = React.useMemo(() => (yours.length > 0 ? [...installed, ...yours] : installed), [installed, yours]);
    return React.useMemo(() => buildAccountWidgetAddSections({
        candidates,
        instances,
        addInstance,
        scope,
        labels,
        ...(context ? { context } : {}),
        renderTilePreview: (candidate) => scope ? (
            <WidgetSetupPreview scope={scope} providedContext={context ? widgetProvidedContext(context) : NO_PROVIDED_CONTEXT}
                candidate={candidate} draft={proposeWidgetSetupDraft(widgetSetupFieldsForCandidate(candidate, context ?? NO_CONTEXT, 'personal'))}
                testID={`${testID}.preview.${candidate.key}`} />
        ) : null,
        ...(scope ? {
            renderSetupPreview: (candidate: WidgetCandidate, preview: Readonly<{ draft: { bindings: WidgetInputBindingsV1 } }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={context ? widgetProvidedContext(context) : NO_PROVIDED_CONTEXT}
                    candidate={candidate}
                    draft={{ bindings: preview.draft.bindings }}
                    testID={`${testID}.setupPreview.${candidate.key}`}
                />
            ),
        } : {}),
    }), [addInstance, appRuntime, candidates, context, instances, labels, scope, testID]);
}
