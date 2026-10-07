import { PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { validatePluginDragSourceReferenceV1, isPluginDropTargetActionAllowedV1, type PluginDragSourceContributionV1, type PluginDropTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/entityDragDrop';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { EntityDropAdmissionV1Schema, PluginUiJsonValueV1Schema, type EntityDragScopeV1, type EntityDropAdmissionV1, type PluginUiJsonValueV1, type EntityDropOutcomeV1, type PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { EntityDragCarry, EntityDragDropRuntime, EntityDropResolveContext, EntityDragSourceDescription } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import type { WindowBounds } from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { randomUUID } from '@/platform/randomUUID';
import { readPluginSurfaceHostApiErrorPayload, type PluginSurfaceHostApiV1 } from '../createPluginSurfaceHostApi';

export type PluginEntityDragSourceRegistration = Readonly<{
    descriptor: PluginDragSourceContributionV1;
    describe: (reference: PluginUiJsonValueV1) => EntityDragSourceDescription | null;
    fallbackDescription?: EntityDragSourceDescription;
    isCurrent: () => boolean;
}>;
export type PluginEntityDropTargetRegistration = Readonly<{
    descriptor: PluginDropTargetContributionV1;
    resolve: (context: Omit<EntityDropResolveContext, 'pointer'> & Readonly<{ targetInput: PluginUiJsonValueV1 | null }>) => EntityDropAdmissionV1;
    isCurrent: () => boolean;
}>;
export type PluginEntityDragSourceMount = Readonly<{ id: string; isCurrent: () => boolean; begin: (input?: 'pointer' | 'keyboard') => EntityDragCarry | null; dispose: () => void }>;
export type PluginEntityDropTargetMount = Readonly<{ id: string; isCurrent: () => boolean; dispose: () => void }>;
export type PluginEntityDragDropBinding = Readonly<{
    runtime: EntityDragDropRuntime;
    runtimeMountId: (mountId: string) => string;
    waitForSourceRegistration: (localId: string, signal?: AbortSignal) => Promise<boolean>;
    waitForTargetRegistration: (localId: string, signal?: AbortSignal) => Promise<boolean>;
    mountSource: (input: Readonly<{ mountId: string; sourceId: string; reference: PluginUiJsonValueV1 }>) => PluginEntityDragSourceMount | null;
    mountTarget: (input: Readonly<{ mountId: string; targetId: string; input?: PluginUiJsonValueV1; parentId?: string; getBounds: () => WindowBounds | null; refreshBounds?: () => Promise<void> }>) => PluginEntityDropTargetMount | null;
    refreshMeasurements: () => Promise<void>;
    refresh: () => void;
    dispose: () => void;
}>;
export type CreatePluginEntityDragDropBindingInput = Readonly<{
    runtime: EntityDragDropRuntime;
    pluginId: string;
    mountKey: string;
    scope: EntityDragScopeV1;
    isCurrent: () => boolean;
    readSource: (id: string) => PluginEntityDragSourceRegistration | null;
    /** Retained mounts stay registered while their incumbent presentation is inactive. */
    isInteractionEnabled?: () => boolean;
    readTarget: (id: string) => PluginEntityDropTargetRegistration | null;
    isSourceDeclared?: (id: string) => boolean;
    isTargetDeclared?: (id: string) => boolean;
    subscribeRegistrations?: (listener: () => void) => () => void;
    executeAction: (action: string | Readonly<{ pluginId: string; localId: string }>, input: PluginUiJsonValueV1) => Promise<EntityDropOutcomeV1>;
}>;

/** The Action front door's settlement, not callback-returned lookalike error bags. */
export function settlePluginEntityDropActionResult(result: unknown, action: string | Readonly<{ pluginId: string; localId: string }>): EntityDropOutcomeV1 {
    const failure = readPluginSurfaceHostApiErrorPayload(result);
    if (failure) return { status: failure.code === 'timeout' || failure.diagnostics.includes(PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE) ? 'unknown' : 'refused',
        reason: { code: failure.diagnostics[0] ?? failure.code, message: failure.diagnostics[0] ?? failure.code } };
    if (typeof action === 'string' && PluginInvocableActionIdSchema.safeParse(action).success && result !== null && typeof result === 'object' && 'kind' in result && result.kind === 'approval_request_created') {
        return { status: 'refused', reason: { code: 'approval_required', message: 'Approval is required before applying this action.' } };
    }
    return { status: 'applied' };
}

/** Each completed physical drop is a new intent; only replay retains an issued request identity. */
export async function executeMountedPluginEntityDropAction(
    mounted: Readonly<{ hostApi: Pick<PluginSurfaceHostApiV1, 'handleRequest'>; surfaceContext: PluginUiSurfaceContextV1 }>,
    action: string | Readonly<{ pluginId: string; localId: string }>,
    input: PluginUiJsonValueV1,
): Promise<EntityDropOutcomeV1> {
    const result = await mounted.hostApi.handleRequest({ version: 1, requestId: randomUUID(),
        surface: mounted.surfaceContext, method: 'executeAction', payload: { action, input } });
    return settlePluginEntityDropActionResult(result, action);
}

/** Mount/authority adapter only; E01 remains the source, target and carry decision owner. */
export function createPluginEntityDragDropBinding(input: CreatePluginEntityDragDropBindingInput): PluginEntityDragDropBinding {
    const disposals = new Set<() => void>();
    const measurements = new Map<() => void, () => Promise<void>>();
    let disposed = false;
    const current = () => !disposed && input.isCurrent();
    const interactionEnabled = () => current() && input.isInteractionEnabled?.() !== false;
    const id = (mountId: string) => `${input.mountKey}\u0000${mountId}`;
    const refusal = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: { code, message: code } });
    const waitForRegistration = (localId: string, read: (id: string) => { isCurrent: () => boolean } | null, isDeclared: ((id: string) => boolean) | undefined, signal?: AbortSignal): Promise<boolean> => {
        if (!current() || signal?.aborted) return Promise.resolve(false);
        if (read(localId)?.isCurrent()) return Promise.resolve(true);
        if (!isDeclared?.(localId) || !input.subscribeRegistrations) return Promise.resolve(false);
        return new Promise(resolve => {
            let finished = false;
            let unsubscribe = () => {};
            const finish = (ready: boolean) => {
                if (finished) return;
                finished = true;
                unsubscribe();
                signal?.removeEventListener('abort', cancel);
                disposals.delete(cancel);
                resolve(ready);
            };
            const cancel = () => finish(false);
            const inspect = () => {
                if (!current() || signal?.aborted || !isDeclared(localId)) finish(false);
                else if (read(localId)?.isCurrent()) finish(true);
            };
            disposals.add(cancel);
            signal?.addEventListener('abort', cancel, { once: true });
            unsubscribe = input.subscribeRegistrations!(inspect);
            if (finished) unsubscribe();
            else inspect();
        });
    };
    const ownRetirement = (retire: () => void, refreshBounds?: () => Promise<void>) => {
        let retired = false;
        const dispose = () => {
            if (retired) return;
            retired = true;
            disposals.delete(dispose);
            measurements.delete(dispose);
            retire();
        };
        disposals.add(dispose);
        if (refreshBounds) measurements.set(dispose, refreshBounds);
        return dispose;
    };
    return Object.freeze({
        runtime: input.runtime,
        runtimeMountId: id,
        waitForSourceRegistration: (localId, signal) => waitForRegistration(localId, input.readSource, input.isSourceDeclared, signal),
        waitForTargetRegistration: (localId, signal) => waitForRegistration(localId, input.readTarget, input.isTargetDeclared, signal),
        mountSource: mount => {
            if (!current()) return null;
            const registration = input.readSource(mount.sourceId);
            if (!registration?.isCurrent()) return null;
            const parsed = PluginUiJsonValueV1Schema.safeParse(mount.reference);
            if (!parsed.success) return null;
            try { if (!validatePluginDragSourceReferenceV1(registration.descriptor, parsed.data)) return null; }
            catch { return null; }
            const sourceId = id(mount.mountId);
            let mounted = true;
            const isCurrent = () => {
                const latest = input.readSource(mount.sourceId);
                return mounted && current() && registration.isCurrent() && latest?.describe === registration.describe
                    && latest.descriptor === registration.descriptor;
            };
            const item = { kind: 'plugin' as const, scope: input.scope,
                contribution: { pluginId: input.pluginId, localId: registration.descriptor.id }, reference: parsed.data };
            const participantCurrent = () => isCurrent() && interactionEnabled();
            const retire = input.runtime.registerSource({ id: sourceId, scope: input.scope,
                isCurrent: participantCurrent, getItem: () => participantCurrent() ? item : null,
                describe: () => {
                    if (!isCurrent()) return null;
                    const fallback = input.readSource(mount.sourceId)?.fallbackDescription;
                    const description = registration.describe(parsed.data);
                    return description ? { ...fallback, ...description } : fallback ?? null;
                } });
            return Object.freeze({ id: sourceId, isCurrent, begin: (activation?: 'pointer' | 'keyboard') => participantCurrent() ? input.runtime.begin(sourceId, activation) : null,
                dispose: ownRetirement(() => { mounted = false; retire(); }) });
        },
        mountTarget: mount => {
            if (!current()) return null;
            const registration = input.readTarget(mount.targetId);
            if (!registration?.isCurrent()) return null;
            const targetInput = PluginUiJsonValueV1Schema.safeParse(mount.input ?? null);
            if (!targetInput.success) return null;
            let mounted = true;
            const isCurrent = () => {
                const latest = input.readTarget(mount.targetId);
                return mounted && current() && registration.isCurrent() && latest?.resolve === registration.resolve
                    && latest.descriptor === registration.descriptor;
            };
            const targetId = id(mount.mountId);
            const allowedAction = (actionId: string) => isPluginDropTargetActionAllowedV1(registration.descriptor, input.pluginId, actionId);
            const retire = input.runtime.registerTarget({ id: targetId, scope: input.scope,
                acceptedKinds: registration.descriptor.acceptedKinds,
                ...(mount.parentId === undefined ? {} : { parentId: mount.parentId }),
                getBounds: mount.getBounds, isCurrent: () => isCurrent() && interactionEnabled(),
                ...(mount.refreshBounds ? { measureBounds: mount.refreshBounds } : {}),
                resolve: context => {
                    if (!isCurrent() || !interactionEnabled()) return refusal('plugin-drag-occurrence-retired');
                    const parsed = EntityDropAdmissionV1Schema.safeParse(registration.resolve({ item: context.item,
                        destination: context.destination, input: context.input, targetInput: targetInput.data }));
                    if (!parsed.success) return refusal('plugin-drop-admission-invalid');
                    return parsed.data.status === 'allowed' && !allowedAction(parsed.data.effect.actionId)
                        ? refusal('plugin-drop-action-not-declared') : parsed.data;
                },
                execute: async effect => {
                    if (!isCurrent() || !interactionEnabled() || !allowedAction(effect.actionId)) {
                        return { status: 'refused', reason: { code: 'plugin-drop-action-unavailable', message: 'plugin-drop-action-unavailable' } };
                    }
                    const action = effect.actionId.startsWith('plugin:')
                        ? parseQualifiedPluginContributionKey(effect.actionId.slice(7)) : effect.actionId;
                    if (!action) return { status: 'refused', reason: { code: 'plugin-drop-action-invalid', message: 'plugin-drop-action-invalid' } };
                    return input.executeAction(action, effect.input);
                },
            });
            return Object.freeze({ id: targetId, isCurrent, dispose: ownRetirement(() => { mounted = false; retire(); }, mount.refreshBounds) });
        },
        refreshMeasurements: async () => {
            await Promise.all([...measurements.values()].map(measure => measure()));
            if (current()) input.runtime.refresh();
        },
        refresh: () => { if (current()) input.runtime.refresh(); },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const dispose of [...disposals]) dispose();
        },
    });
}
