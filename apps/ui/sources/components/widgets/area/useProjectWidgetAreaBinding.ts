import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { JsonValue } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { ProjectSourcesReadOutputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ProjectAttachedDashboardSelection } from '@/components/projects/detail/projectRouteState';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { executeWidgetEntityMovement, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';

import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { createWidgetAreaSelectionReadHandoff, useWidgetAreaLayoutSelectionOwner } from './widgetAreaLayoutSelection';
import { widgetAreaLayoutBaseSurface, type WidgetAreaLayoutSelectionOwner } from '@/sync/domains/widgets/widgetAreaLayoutSelection';
import { useProjectDashboardDocument, type ProjectDashboardDocumentRead } from './useProjectDashboardDocument';

/** One value the Project page fills, named for people ("happier-dev/happier", "MacBook Pro · main"). */
export type ProjectWidgetAreaValue = Readonly<{ value: JsonValue; label: string; description?: string }>;

/**
 * What a Project's widgets follow (lab `dashboards` P1, Q4): repository-wide inputs follow
 * "This project" (its portable source); checkout-local inputs follow "This checkout", the page's
 * checkout chip. Usage's plural projects slot follows the admitted Project identity independently
 * of either Source or checkout availability. A slot the page cannot fill yet asks for its input.
 */
export function projectWidgetAreaContext(input: Readonly<{
    project: ProjectWidgetAreaValue | null;
    projects?: ProjectWidgetAreaValue | null;
    checkout: ProjectWidgetAreaValue | null;
}>): WidgetSurfaceContext {
    const slot = (label: string, value: ProjectWidgetAreaValue | null): WidgetSurfaceContextSlot => ({ label, value });
    return { slots: { project: slot(t('widgetAdd.thisProject'), input.project),
        projects: slot(t('widgetAdd.thisProject'), input.projects ?? null),
        checkout: slot(t('widgetAdd.thisCheckout'), input.checkout) } };
}

export type ProjectWidgetAreaBindingInput = Readonly<{
    serverId: string;
    projectName: string;
    /** Accepted base ref anchors the stable Project even when no active checkout is available. */
    projectRef?: unknown;
    /** The page's exact checkout behind its checkout chip; never portable Source identity. */
    activeCheckout?: unknown;
    activeCheckoutLabel?: string;
    layoutId?: string;
    artifactId?: string;
    /** An attached shared layout's owner, not the signed-in actor. */
    ownerAccountId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    /** Overview lends its route owner; a standalone Code aside keeps selection locally. */
    onSelectLayout?: (layoutId: string | null) => void;
}>;

/** An attached shared dashboard as this viewer was admitted to it: its name, revision and the viewer's own access. */
export type ProjectAttachedDashboardRead = ProjectDashboardDocumentRead;

export type ProjectWidgetAreaBinding = Readonly<{
    port: WidgetAreaPort | null;
    context: WidgetSurfaceContext;
    unavailableReasonCode?: string;
    sharedDashboard?: ProjectAttachedDashboardRead;
}>;

function hasDashboardAttachment(source: ProjectSourceV1 | null | undefined, selection: ProjectAttachedDashboardSelection, serverId: string): boolean {
    return source?.id === selection.sourceId && (source.attachments ?? []).some(attachment => attachment.purpose === 'dashboard'
        && attachment.ref.artifactId === selection.artifactId
        && areServerProfileIdentifiersEquivalent(attachment.ref.serverId ?? serverId, selection.serverId ?? serverId));
}

/** One captured Project layout binding; the Action and Artifact owners retain all access policy. */
export function useProjectWidgetAreaBinding(props: ProjectWidgetAreaBindingInput): ProjectWidgetAreaBinding {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = lifetime?.scope ?? null;
    const demand = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef, activeCheckout: props.activeCheckout }),
        [props.activeCheckout, props.projectRef, props.serverId]);
    const sourceRead = useProjectSource(lifetime?.isCurrent() && selectActiveServerAccountScopeForServer(viewer, props.serverId) ? lifetime : null,
        props.attachedDashboard?.sourceId ?? demand.sourceId);
    const nextRead = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef,
        activeCheckout: props.activeCheckout, source: sourceRead.source }), [props.activeCheckout, props.projectRef, props.serverId, sourceRead.source]);
    // Snapshot publications can replace an equivalent checkout. Only a changed binding
    // retires the area's in-flight read, not that publication's object identity.
    const stableRead = React.useRef(nextRead);
    if (!sameStrictJsonValue(stableRead.current, nextRead)) stableRead.current = nextRead;
    const read = stableRead.current;
    const selectionKey = JSON.stringify([lifetime?.scope, read.projectIdentity?.projectKey]);
    const [selection, setSelection] = React.useState<Readonly<{ key: string; initial?: string; layoutId?: string }> | null>(null);
    const locallySelected = !props.onSelectLayout && selection?.key === selectionKey && selection.initial === props.layoutId;
    const layoutId = locallySelected ? selection.layoutId : props.layoutId;
    const context = React.useMemo(() => {
        const project = read.providedContext.project?.[0];
        const projects = read.providedContext.projects?.[0];
        const checkout = read.providedContext.checkout?.[0];
        return projectWidgetAreaContext({
            project: project === undefined ? null : { value: project, label: props.projectName },
            projects: projects === undefined ? null : { value: projects, label: props.projectName },
            checkout: checkout === undefined ? null : { value: checkout, label: props.activeCheckoutLabel ?? props.projectName },
        });
    }, [props.activeCheckoutLabel, props.projectName, read]);
    const attached = props.attachedDashboard;
    const attachmentEligible = attached !== undefined && demand.sourceId === attached.sourceId
        && hasDashboardAttachment(sourceRead.source?.source, attached, props.serverId);
    const attachedRead = useProjectDashboardDocument(attachmentEligible ? attached! : null, props.serverId);
    const sharedDashboard = attachmentEligible ? attachedRead.document ?? undefined : undefined;
    const surface = React.useMemo((): WidgetSurfaceRefV1 | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) || !read.projectIdentity) return null;
        if (attached) return sharedDashboard?.surface ?? null;
        const parsed = WidgetSurfaceRefV1Schema.safeParse({
            serverId: lifetime.scope.serverId, accountId: locallySelected ? lifetime.scope.accountId : props.ownerAccountId ?? lifetime.scope.accountId,
            ...(locallySelected || props.artifactId === undefined ? {} : { artifactId: props.artifactId }),
            owner: { kind: 'project', projectId: read.projectIdentity.projectKey,
                ...(layoutId === undefined ? {} : { layoutId }) },
        });
        return parsed.success ? parsed.data : null;
    }, [attached?.sourceId, attached?.artifactId, attached?.serverId, lifetime, locallySelected, props.artifactId, layoutId, props.ownerAccountId, props.serverId, read.projectIdentity, sharedDashboard, viewer]);
    const mounted = React.useRef(true);
    const [readHandoff] = React.useState(() => createWidgetAreaSelectionReadHandoff<ActionExecuteResult>());
    const handoffBinding = React.useMemo(() => ({}), [lifetime, read.providedContext]);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; readHandoff.cancel(); }; }, [readHandoff]);
    const currentBinding = React.useRef({ surface, context: read.providedContext, selectionKey });
    currentBinding.current = { surface, context: read.providedContext, selectionKey };
    const port = React.useMemo((): WidgetAreaPort | null => {
        if (!surface || !lifetime) return null;
        const failed = (errorCode: string): PluginUiWidgetAreaResultV1 => ({ ok: false, errorCode, error: errorCode });
        const widgetAreaContext = { surface, values: read.providedContext };
        const isCurrent = () => mounted.current && lifetime.isCurrent() && currentBinding.current.surface === surface
            && currentBinding.current.context === read.providedContext;
        const execute: WidgetAreaPort['execute'] = async (operation, signal, admitted) => {
            if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
            const target = admitted?.surface ?? surface;
            if (!sameStrictJsonValue(widgetAreaLayoutBaseSurface(target), widgetAreaLayoutBaseSurface(surface))) return failed('widget_area_owner_mismatch');
            const offered = !attached && operation.actionId === 'widgets.item.list' && !admitted
                ? readHandoff.take(target, handoffBinding, signal) : null;
            if (offered) {
                const result = await offered;
                if (result) {
                    if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
                    const parsed = PluginUiWidgetAreaResultV1Schema.safeParse(result);
                    return parsed.success ? parsed.data : failed('invalid_widget_area_result');
                }
            }
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
            const executor = createDefaultActionExecutor();
            if (attached) {
                const source = await executor.execute('projects.sources.read', { serverId: lifetime.scope.serverId, sourceId: attached.sourceId }, {
                    surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal });
                const parsed = source.ok ? ProjectSourcesReadOutputV1Schema.safeParse(source.result) : null;
                if (!parsed?.success || !parsed.data.ok || !hasDashboardAttachment(parsed.data.source, attached, lifetime.scope.serverId)) return failed('widget_project_source_unavailable');
                if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
            }
            const result = await executor.execute(operation.actionId, buildWidgetAreaActionInputV1(operation, target), {
                surface: 'ui', actionCaller: { kind: 'host' }, serverId: sharedDashboard?.viewerScope.serverId ?? lifetime.scope.serverId,
                expectedAccountId: sharedDashboard?.viewerScope.accountId ?? lifetime.scope.accountId, signal,
                widgetAreaContext: admitted ? { surface: target, values: widgetProvidedContext(admitted.context) } : widgetAreaContext,
            });
            // Preserve a real effect acknowledgement; retired reads disclose no Account content.
            if ((!isCurrent() || signal?.aborted) && !(result.ok && pluginUiWidgetAreaOperationHasOutwardEffectV1(operation))) return failed('widget_area_scope_retired');
            const parsed = PluginUiWidgetAreaResultV1Schema.safeParse(result);
            return parsed.success ? parsed.data : failed('invalid_widget_area_result');
        };
        const readMovementContext = async (destination: WidgetSurfaceRefV1, signal?: AbortSignal) => {
            const result = await execute({ actionId: 'widgets.item.list' }, signal);
            if (!result.ok) return { ok: false, code: result.errorCode ?? 'widget_area_unavailable' } as const;
            const admitted = WidgetSurfaceReadV1Schema.safeParse(result.result);
            if (!admitted.success) return { ok: false, code: 'invalid_widget_area_result' } as const;
            if (!sameStrictJsonValue(admitted.data.surface, destination)) return { ok: false, code: 'widget_destination_changed' } as const;
            return { ok: true, context: { surface: admitted.data.surface, values: read.providedContext } } as const;
        };
        return {
            execute,
            movement: {
                readAdmission: async (ref, destination, signal) => {
                    const admitted = await readMovementContext(destination, signal);
                    if (!admitted.ok) return { status: 'refused', code: admitted.code };
                    const { readDefaultWidgetMovementAdmission } = await import('@/sync/ops/actions/defaultActionExecutor');
                    if (!isCurrent()) return { status: 'refused', code: 'widget_area_scope_retired' };
                    return readDefaultWidgetMovementAdmission(ref, destination, signal, admitted.context);
                },
                execute: async (effect, scope) => {
                    // Drag scopes identify the layout owner; the captured lifetime identifies its editor.
                    if (!isCurrent() || !areServerAccountScopesEqual(scope, surface)) return widgetMovementRefused('widget_area_scope_retired', effect.preview);
                    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
                    if (!move.success) return widgetMovementRefused('invalid_parameters', effect.preview);
                    const destination = 'to' in move.data ? move.data.to.surface : move.data.ref.surface;
                    const admitted = await readMovementContext(destination);
                    if (!admitted.ok) return widgetMovementRefused(admitted.code, effect.preview);
                    if (!isCurrent()) return widgetMovementRefused('widget_area_scope_retired', effect.preview);
                    return executeWidgetEntityMovement(effect, sharedDashboard?.viewerScope ?? lifetime.scope, admitted.context);
                },
            },
        };
    }, [attached?.sourceId, attached?.artifactId, attached?.serverId, handoffBinding, lifetime, readHandoff, read.providedContext, sharedDashboard?.viewerScope, surface]);
    const selectionOwner = React.useMemo((): WidgetAreaLayoutSelectionOwner | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) || !read.projectIdentity) return null;
        // The mounted Project is the viewer's destination even while displaying an attached document.
        const destination: WidgetSurfaceRefV1 = { ...lifetime.scope, owner: { kind: 'project', projectId: read.projectIdentity.projectKey } };
        const isCurrent = () => mounted.current && lifetime.isCurrent() && currentBinding.current.selectionKey === selectionKey
            && currentBinding.current.context === read.providedContext;
        return { surface: destination, displayedSurface: surface ?? undefined, isCurrent, providedContext: read.providedContext,
            read: (target, signal) => {
                const start = async (readSignal: AbortSignal | undefined) => {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    if (!isCurrent() || readSignal?.aborted) return { ok: false as const, errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' };
                    return createDefaultActionExecutor().execute('widgets.item.list', { surface: target }, {
                        surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                        expectedAccountId: lifetime.scope.accountId, signal: readSignal, widgetAreaContext: { surface: target, values: read.providedContext },
                    });
                };
                return attached ? start(signal) : readHandoff.offer(target, handoffBinding, signal, start);
            },
            select: target => {
                if (target.owner.kind !== 'project') return;
                // An explicitly addressed displayed document is already selected; its owner's
                // layout id must not become a selection in the recipient's personal Project.
                if (surface?.artifactId && sameStrictJsonValue(target, surface)) return;
                if (props.onSelectLayout) props.onSelectLayout(target.owner.layoutId ?? null);
                else setSelection({ key: selectionKey, initial: props.layoutId, layoutId: target.owner.layoutId });
            },
        };
    }, [attached, handoffBinding, lifetime, props.layoutId, props.onSelectLayout, props.serverId, read.projectIdentity, read.providedContext, readHandoff, selectionKey, surface, viewer]);
    useWidgetAreaLayoutSelectionOwner(selectionOwner);
    const unavailableReasonCode = port ? undefined
        : !lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) ? 'widget_area_scope_unavailable'
        : attached ? !attachmentEligible ? 'widget_project_source_unavailable' : attachedRead.loaded ? 'widget_area_unavailable' : 'widget_area_loading'
        : 'widget_project_identity_unavailable';
    return React.useMemo(() => ({ port, context, ...(sharedDashboard ? { sharedDashboard } : {}), ...(unavailableReasonCode ? { unavailableReasonCode } : {}) }),
        [context, port, sharedDashboard, unavailableReasonCode]);
}
