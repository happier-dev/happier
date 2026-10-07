import * as React from 'react';
import { normalizeWidgetSizeForSurfaceV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useHomeWidgetCandidates } from '@/components/hub/layout/useHomeWidgetCandidates';
import { useYourWidgetCandidates } from '@/components/widgets/definitions/useYourWidgetCandidates';
import {
    buildWidgetCandidateSetup,
    countWidgetInstances,
    groupWidgetCandidatesByPlugin,
    isConfigurableWidgetCandidate,
    partitionWidgetCandidatesBySource,
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
}>;

/**
 * What a personal surface's Add offers (lab `widget-add` wsplit A): Happier's own widgets (Built in),
 * each plugin's widgets under its name, and Your widgets, counted by the copies already there. Every
 * widget is added from its pane — inputs first, its live body at the chosen size, then Add — and a
 * widget without inputs that is already here stays Added. Every add is the surface's one add intent,
 * the same operation `widgets.instance.add` performs for an agent.
 */
export function buildAccountWidgetAddSections(input: AccountWidgetAddInput): readonly WidgetAddSection[] {
    const context = input.context ?? NO_CONTEXT;
    const entry = (candidate: WidgetCandidate): WidgetAddEntry => {
        const definition = widgetDefinitionOfCandidate(candidate);
        const copies = countWidgetInstances(input.instances, definition);
        const configurable = isConfigurableWidgetCandidate(candidate);
        const add = (bindings: WidgetInputBindingsV1, size?: WidgetSizeV1) => input.addInstance({ v: 1, id: randomUUID(), definition, bindings },
            input.scope ? normalizeWidgetSizeForSurfaceV1(input.scope.owner.kind, size, candidate.sizeDeclaration) : undefined);
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
            ...(candidate.description ? { subtitle: candidate.description } : {}),
            icon: candidate.icon,
            ...(configurable
                ? (copies > 0 ? { count: input.labels.count(copies) } : {})
                : { added: copies > 0 }),
            setup: () => setup,
        };
    };
    const widgets = partitionWidgetCandidatesBySource(input.candidates);
    return [
        { id: 'builtins', title: t('widgetAdd.builtIn'), entries: widgets.builtIn.map(entry) },
        ...groupWidgetCandidatesByPlugin(widgets.fromPlugins).map((group) => ({
            id: `plugin:${group.id}`, title: group.title, hint: t('widgetAdd.pluginTag'), pluginId: group.id, entries: group.candidates.map(entry),
        })),
        // Definitions the person or their agents made (lab dbind G), only when there are any.
        ...(widgets.yours.length > 0 ? [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), hint: t('widgetDefinition.yourWidgetsHint'),
            entries: widgets.yours.map(entry) }] : []),
    ];
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
        ...(scope ? {
            renderSetupPreview: (candidate: WidgetCandidate, preview: Readonly<{ draft: WidgetSetupDraft }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={context ? widgetProvidedContext(context) : NO_PROVIDED_CONTEXT}
                    candidate={candidate}
                    draft={preview.draft}
                    testID={`${testID}.setupPreview.${candidate.key}`}
                />
            ),
        } : {}),
    }), [addInstance, appRuntime, candidates, context, instances, labels, scope, testID]);
}
