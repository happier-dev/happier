import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { readWidgetSurfaceArtifactV1, WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { ProjectSourcesReadOutputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useActiveServerAccountScope, useArtifact } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ProjectAttachedDashboardSelection } from '@/components/projects/detail/projectRouteState';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { executeWidgetEntityMovement, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';

import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { registerWidgetAreaLayoutSelectionOwner } from './widgetAreaLayoutSelection';

/** One value the Project page fills, named for people ("happier-dev/happier", "MacBook Pro · main"). */
export type ProjectWidgetAreaValue = Readonly<{ value: JsonValue; label: string; description?: string }>;

/**
 * What a Project's widgets follow (lab `dashboards` P1, Q4): repository-wide inputs follow
 * "This project" (its portable source); checkout-local inputs follow "This checkout", the page's
 * checkout chip. A slot the page cannot fill yet is never followed, so its input is asked for.
 */
export function projectWidgetAreaContext(input: Readonly<{
    project: ProjectWidgetAreaValue | null;
    checkout: ProjectWidgetAreaValue | null;
}>): WidgetSurfaceContext {
    const slot = (label: string, value: ProjectWidgetAreaValue | null): WidgetSurfaceContextSlot => ({ label, value });
    return { slots: { project: slot(t('widgetAdd.thisProject'), input.project), checkout: slot(t('widgetAdd.thisCheckout'), input.checkout) } };
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

export type ProjectAttachedDashboardRead = Readonly<{ artifactId: string; surface: WidgetSurfaceRefV1; name: string }>;

export type ProjectWidgetAreaBinding = Readonly<{
    port: WidgetAreaPort | null;
    context: WidgetSurfaceContext;
    unavailableReasonCode?: string;
    sharedDashboard?: ProjectAttachedDashboardRead;
}>;

function hasDashboardAttachment(source: ProjectSourceV1 | null | undefined, selection: ProjectAttachedDashboardSelection, serverId: string): boolean {
    return source?.id === selection.sourceId && (source.attachments ?? []).some(attachment => attachment.purpose === 'dashboard'
        && attachment.ref.artifactId === selection.artifactId
        && (attachment.ref.serverId === undefined || areServerProfileIdentifiersEquivalent(attachment.ref.serverId, serverId)));
}

/** One captured Project layout binding; the Action and Artifact owners retain all access policy. */
export function useProjectWidgetAreaBinding(props: ProjectWidgetAreaBindingInput): ProjectWidgetAreaBinding {
    const viewer = useActiveServerAccountScope();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    const demand = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef, activeCheckout: props.activeCheckout }),
        [props.activeCheckout, props.projectRef, props.serverId]);
    const sourceRead = useProjectSource(lifetime?.isCurrent() && selectActiveServerAccountScopeForServer(viewer, props.serverId) ? lifetime : null,
        props.attachedDashboard?.sourceId ?? demand.sourceId);
    const read = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef,
        activeCheckout: props.activeCheckout, source: sourceRead.source }), [props.activeCheckout, props.projectRef, props.serverId, sourceRead.source]);
    const selectionKey = JSON.stringify([lifetime?.scope, read.projectIdentity?.projectKey]);
    const [selection, setSelection] = React.useState<Readonly<{ key: string; initial?: string; layoutId?: string }> | null>(null);
    const locallySelected = !props.onSelectLayout && selection?.key === selectionKey && selection.initial === props.layoutId;
    const layoutId = locallySelected ? selection.layoutId : props.layoutId;
    const context = React.useMemo(() => {
        const project = read.providedContext.project?.[0];
        const checkout = read.providedContext.checkout?.[0];
        return projectWidgetAreaContext({
            project: project === undefined ? null : { value: project, label: props.projectName },
            checkout: checkout === undefined ? null : { value: checkout, label: props.activeCheckoutLabel ?? props.projectName },
        });
    }, [props.activeCheckoutLabel, props.projectName, read]);
    const attached = props.attachedDashboard;
    const attachmentEligible = attached !== undefined && demand.sourceId === attached.sourceId
        && hasDashboardAttachment(sourceRead.source?.source, attached, props.serverId);
    const publication = useArtifact(attached?.artifactId ?? '');
    const attachedKey = attached ? JSON.stringify([lifetime?.scope, props.serverId, attached.sourceId, attached.artifactId]) : '';
    const [attachedRead, setAttachedRead] = React.useState<Readonly<{ key: string; publication?: ReturnType<typeof useArtifact>;
        dashboard: ProjectAttachedDashboardRead | null; reasonCode?: string }>>({ key: '', dashboard: null });
    React.useEffect(() => {
        if (!attached || !attachmentEligible || !lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId)) return;
        const controller = new AbortController();
        void (async () => {
            try {
                const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                const account = await captureLazyActionAccountContext(props.serverId, controller.signal);
                try {
                    const row = await account.homeHubArtifactTransport.read(attached.artifactId, { signal: controller.signal });
                    const layout = row ? readWidgetSurfaceArtifactV1(row) : null;
                    if (!layout || layout.surface.owner.kind !== 'project' || row?.ownerAccountId !== layout.surface.accountId
                        || layout.surface.serverId !== account.serverId) throw new Error('widget_area_owner_mismatch');
                    if (!controller.signal.aborted && lifetime.isCurrent()) setAttachedRead({ key: attachedKey, publication,
                        dashboard: { artifactId: attached.artifactId, surface: { ...layout.surface, artifactId: attached.artifactId },
                            name: layout.name ?? t('projects.pages.overview') } });
                } finally { account.dispose(); }
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) setAttachedRead({ key: attachedKey, publication, dashboard: null, reasonCode: 'widget_area_unavailable' });
            }
        })();
        return () => controller.abort();
    }, [attachedKey, attachmentEligible, lifetime, props.serverId, publication]);
    const attachedReadCurrent = attachedRead.key === attachedKey && attachedRead.publication === publication;
    const sharedDashboard = attachmentEligible && attachedReadCurrent ? attachedRead.dashboard ?? undefined : undefined;
    const surface = React.useMemo((): WidgetSurfaceRefV1 | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) || !read.projectIdentity) return null;
        if (attached) return sharedDashboard?.surface ?? null;
        const parsed = WidgetSurfaceRefV1Schema.safeParse({
            serverId: lifetime.scope.serverId, accountId: props.ownerAccountId ?? lifetime.scope.accountId,
            ...(locallySelected || props.artifactId === undefined ? {} : { artifactId: props.artifactId }),
            owner: { kind: 'project', projectId: read.projectIdentity.projectKey,
                ...(layoutId === undefined ? {} : { layoutId }) },
        });
        return parsed.success ? parsed.data : null;
    }, [attached?.sourceId, attached?.artifactId, lifetime, locallySelected, props.artifactId, layoutId, props.ownerAccountId, props.serverId, read.projectIdentity, sharedDashboard, viewer]);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const currentBinding = React.useRef({ surface, context: read.providedContext });
    currentBinding.current = { surface, context: read.providedContext };
    const port = React.useMemo((): WidgetAreaPort | null => {
        if (!surface || !lifetime) return null;
        const failed = (errorCode: string): PluginUiWidgetAreaResultV1 => ({ ok: false, errorCode, error: errorCode });
        const widgetAreaContext = { surface, values: read.providedContext };
        const isCurrent = () => mounted.current && lifetime.isCurrent() && currentBinding.current.surface === surface
            && currentBinding.current.context === read.providedContext;
        const execute: WidgetAreaPort['execute'] = async (operation, signal) => {
            if (!isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
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
            const result = await executor.execute(operation.actionId, buildWidgetAreaActionInputV1(operation, surface), {
                surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId, signal, widgetAreaContext,
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
                    return executeWidgetEntityMovement(effect, lifetime.scope, admitted.context);
                },
            },
        };
    }, [attached?.sourceId, attached?.artifactId, lifetime, read.providedContext, surface]);
    React.useEffect(() => {
        if (!port || !surface || !lifetime || !read.projectIdentity) return;
        // The mounted Project is the viewer's destination even while displaying an attached document.
        const destination: WidgetSurfaceRefV1 = { ...lifetime.scope, owner: { kind: 'project', projectId: read.projectIdentity.projectKey } };
        const isCurrent = () => mounted.current && lifetime.isCurrent() && currentBinding.current.surface === surface
            && currentBinding.current.context === read.providedContext;
        return registerWidgetAreaLayoutSelectionOwner({ surface: destination, isCurrent,
            read: async (target, signal) => {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                if (!isCurrent() || signal?.aborted) return { ok: false, errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' };
                return createDefaultActionExecutor().execute('widgets.item.list', { surface: target }, {
                    surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                    expectedAccountId: lifetime.scope.accountId, signal, widgetAreaContext: { surface: target, values: read.providedContext },
                });
            },
            select: target => {
                if (target.owner.kind !== 'project') return;
                if (props.onSelectLayout) props.onSelectLayout(target.owner.layoutId ?? null);
                else setSelection({ key: selectionKey, initial: props.layoutId, layoutId: target.owner.layoutId });
            },
        });
    }, [lifetime, port, props.layoutId, props.onSelectLayout, read.projectIdentity, read.providedContext, selectionKey, surface]);
    const unavailableReasonCode = port ? undefined
        : !lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) ? 'widget_area_scope_unavailable'
        : attached ? !attachmentEligible ? 'widget_project_source_unavailable' : attachedReadCurrent ? attachedRead.reasonCode ?? 'widget_area_loading' : 'widget_area_loading'
        : 'widget_project_identity_unavailable';
    return React.useMemo(() => ({ port, context, ...(sharedDashboard ? { sharedDashboard } : {}), ...(unavailableReasonCode ? { unavailableReasonCode } : {}) }),
        [context, port, sharedDashboard, unavailableReasonCode]);
}
