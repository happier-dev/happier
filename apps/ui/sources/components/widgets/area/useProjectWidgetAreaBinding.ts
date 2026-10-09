import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import type { WidgetSurfaceContext, WidgetSurfaceContextSlot } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { executeWidgetEntityMovement, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';

import type { WidgetAreaPort } from './useWidgetAreaLayout';

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
    dashboardId?: string;
    artifactId?: string;
    /** An attached shared layout's owner, not the signed-in actor. */
    ownerAccountId?: string;
}>;

export type ProjectWidgetAreaBinding = Readonly<{
    port: WidgetAreaPort | null;
    context: WidgetSurfaceContext;
    unavailableReasonCode?: string;
}>;

/** One captured Project layout binding; the Action and Artifact owners retain all access policy. */
export function useProjectWidgetAreaBinding(props: ProjectWidgetAreaBindingInput): ProjectWidgetAreaBinding {
    const viewer = useActiveServerAccountScope();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    const demand = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef, activeCheckout: props.activeCheckout }),
        [props.activeCheckout, props.projectRef, props.serverId]);
    const sourceRead = useProjectSource(lifetime?.isCurrent() && selectActiveServerAccountScopeForServer(viewer, props.serverId) ? lifetime : null, demand.sourceId);
    const read = React.useMemo(() => readProjectWidgetAreaContextV1({ serverId: props.serverId, projectRef: props.projectRef,
        activeCheckout: props.activeCheckout, source: sourceRead.source }), [props.activeCheckout, props.projectRef, props.serverId, sourceRead.source]);
    const context = React.useMemo(() => {
        const project = read.providedContext.project?.[0];
        const checkout = read.providedContext.checkout?.[0];
        return projectWidgetAreaContext({
            project: project === undefined ? null : { value: project, label: props.projectName },
            checkout: checkout === undefined ? null : { value: checkout, label: props.activeCheckoutLabel ?? props.projectName },
        });
    }, [props.activeCheckoutLabel, props.projectName, read]);
    const surface = React.useMemo((): WidgetSurfaceRefV1 | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) || !read.projectIdentity) return null;
        const parsed = WidgetSurfaceRefV1Schema.safeParse({
            serverId: lifetime.scope.serverId, accountId: props.ownerAccountId ?? lifetime.scope.accountId,
            ...(props.artifactId === undefined ? {} : { artifactId: props.artifactId }),
            owner: { kind: 'project', projectId: read.projectIdentity.projectKey,
                ...(props.dashboardId === undefined ? {} : { dashboardId: props.dashboardId }) },
        });
        return parsed.success ? parsed.data : null;
    }, [lifetime, props.artifactId, props.dashboardId, props.ownerAccountId, props.serverId, read.projectIdentity, viewer]);
    const port = React.useMemo((): WidgetAreaPort | null => {
        if (!surface || !lifetime) return null;
        const failed = (errorCode: string): PluginUiWidgetAreaResultV1 => ({ ok: false, errorCode, error: errorCode });
        const widgetAreaContext = { surface, values: read.providedContext };
        const execute: WidgetAreaPort['execute'] = async (operation, signal) => {
            if (!lifetime.isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!lifetime.isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
            const result = await createDefaultActionExecutor().execute(operation.actionId, buildWidgetAreaActionInputV1(operation, surface), {
                surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId, signal, widgetAreaContext,
            });
            // Preserve a real effect acknowledgement; retired reads disclose no Account content.
            if ((!lifetime.isCurrent() || signal?.aborted) && !(result.ok && pluginUiWidgetAreaOperationHasOutwardEffectV1(operation))) return failed('widget_area_scope_retired');
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
                    if (!lifetime.isCurrent()) return { status: 'refused', code: 'widget_area_scope_retired' };
                    return readDefaultWidgetMovementAdmission(ref, destination, signal, admitted.context);
                },
                execute: async (effect, scope) => {
                    // Drag scopes identify the layout owner; the captured lifetime identifies its editor.
                    if (!lifetime.isCurrent() || !areServerAccountScopesEqual(scope, surface)) return widgetMovementRefused('widget_area_scope_retired', effect.preview);
                    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
                    if (!move.success) return widgetMovementRefused('invalid_parameters', effect.preview);
                    const destination = 'to' in move.data ? move.data.to.surface : move.data.ref.surface;
                    const admitted = await readMovementContext(destination);
                    if (!admitted.ok) return widgetMovementRefused(admitted.code, effect.preview);
                    if (!lifetime.isCurrent()) return widgetMovementRefused('widget_area_scope_retired', effect.preview);
                    return executeWidgetEntityMovement(effect, lifetime.scope, admitted.context);
                },
            },
        };
    }, [lifetime, read.providedContext, surface]);
    const unavailableReasonCode = port ? undefined
        : !lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, props.serverId) ? 'widget_area_scope_unavailable'
        : 'widget_project_identity_unavailable';
    return React.useMemo(() => ({ port, context, ...(unavailableReasonCode ? { unavailableReasonCode } : {}) }), [context, port, unavailableReasonCode]);
}

