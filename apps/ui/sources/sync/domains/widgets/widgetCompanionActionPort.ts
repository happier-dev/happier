import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import type { CurrentSessionPresentationIntentV1 } from '@happier-dev/protocol/sessions';
import type { WidgetActionSurfacePortV1, WidgetMoveCaptureV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { SessionCompanionPreferenceV1 } from '@/components/sessions/companion/state/sessionCompanionPreference';
import type { SessionCompanionMutationObserver } from '@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export function createWidgetCompanionActionPortV1(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    readPreference(surface: WidgetSurfaceRefV1): SessionCompanionPreferenceV1 | null;
    applyPresentation(surface: WidgetSurfaceRefV1, intent: CurrentSessionPresentationIntentV1, context: ActionExecutorContext, signal?: AbortSignal, onCompanionMutation?: SessionCompanionMutationObserver): Promise<ActionExecuteResult>;
}>): WidgetActionSurfacePortV1 {
    const unavailable = { ok: false as const, errorCode: 'widgets_surface_unavailable', error: 'widgets_surface_unavailable' };
    const readPreference = (surface: WidgetSurfaceRefV1, signal?: AbortSignal) => input.lifetime.isCurrent() && !signal?.aborted
        && surface.owner.kind === 'companion' && surface.serverId === input.lifetime.scope.serverId && surface.accountId === input.lifetime.scope.accountId
        ? input.readPreference(surface) : null;
    const capture = (preference: SessionCompanionPreferenceV1, instanceId: string): WidgetMoveCaptureV1 | null => {
        const nativeIndex = preference.items.findIndex(item => item.kind === 'instance' && item.instance.id === instanceId);
        const item = preference.items[nativeIndex];
        return item?.kind === 'instance' ? { expectedInstance: item.instance,
            expectedPresentation: { frameStyle: item.frameStyle ?? null, nativeIndex } } : null;
    };
    return {
        captureMove: async (surface, instanceId, _context, signal) => {
            const preference = readPreference(surface, signal);
            return preference ? capture(preference, instanceId) ?? { ok: false, errorCode: 'widgets_instance_missing', error: 'widgets_instance_missing' } : unavailable;
        },
        read: async (surface, _context, signal) => {
            const preference = readPreference(surface, signal);
            if (!preference) return unavailable;
            return { surface, canEdit: true, instances: preference.items.flatMap((item) => item.kind === 'instance' ? [{ instance: item.instance, ...(item.frameStyle ? { frameStyle: item.frameStyle } : {}) }] : []) };
        },
        apply: async (surface, mutation, context, signal) => {
            const preference = readPreference(surface, signal);
            if (!preference) return unavailable;
            if (mutation.kind === 'size') return { ok: false, errorCode: 'widgets_size_unavailable', error: 'widgets_size_unavailable' };
            if ((mutation.kind === 'add' && (mutation.placement || mutation.position?.tabId !== undefined))
                || (mutation.kind === 'move' && 'tabId' in mutation && mutation.tabId !== undefined)
                || (mutation.kind === 'remove' && mutation.boardRevisions)) return { ok: false, errorCode: 'widgets_placement_unavailable', error: 'widgets_placement_unavailable' };
            if (mutation.kind === 'add' && mutation.presentation?.size !== undefined) return { ok: false, errorCode: 'widgets_size_unavailable', error: 'widgets_size_unavailable' };
            if (mutation.kind === 'add' && mutation.captureForMove && preference.items.some(item => item.kind === 'instance' && item.instance.id === mutation.instance.id)) {
                return { ok: false, errorCode: 'widgets_instance_exists', error: 'widgets_instance_exists' };
            }
            const item = mutation.kind === 'add' ? { kind: 'instance' as const, instance: mutation.instance,
                ...(mutation.presentation?.frameStyle ? { frameStyle: mutation.presentation.frameStyle } : {}) }
                : preference.items.find((candidate) => candidate.kind === 'instance' && candidate.instance.id === mutation.instanceId);
            if (!item || item.kind !== 'instance') return { ok: false, errorCode: 'widgets_instance_missing', error: 'widgets_instance_missing' };
            let intent: CurrentSessionPresentationIntentV1;
            const insertionIndex = (index: number, movingId?: string) => {
                const remaining = preference.items.filter(candidate => candidate.kind !== 'instance' || candidate.instance.id !== movingId);
                const anchor = remaining.filter(candidate => candidate.kind === 'instance')[index];
                return anchor ? remaining.indexOf(anchor) : remaining.length;
            };
            switch (mutation.kind) {
                case 'add': {
                    const index = mutation.position?.index ?? (mutation.toIndex === undefined ? undefined : insertionIndex(mutation.toIndex));
                    intent = { kind: 'companion.item.add', item, ...(index === undefined ? {} : { index }) }; break;
                }
                case 'remove': intent = { kind: 'companion.item.remove', item,
                    ...(mutation.expectedInstance ? { expectedInstance: mutation.expectedInstance } : {}),
                    ...(mutation.expectedPresentation ? { expectedPresentation: mutation.expectedPresentation } : {}) }; break;
                case 'move': intent = { kind: 'companion.item.move', item, toIndex: 'nativeIndex' in mutation
                    ? mutation.nativeIndex : insertionIndex(mutation.toIndex, mutation.instanceId) }; break;
                case 'frame': intent = { kind: 'companion.item.frameStyle.set', item, frameStyle: mutation.frameStyle }; break;
                case 'rename': intent = { kind: 'companion.instance.rename', instanceId: mutation.instanceId, displayName: mutation.displayName }; break;
                case 'inputs': intent = { kind: 'companion.instance.inputs.set', instanceId: mutation.instanceId, bindings: mutation.bindings }; break;
            }
            const captured: { value: WidgetMoveCaptureV1 | null } = { value: null };
            const result = await input.applyPresentation(surface, intent, context, signal, mutation.kind === 'add' && mutation.captureForMove
                ? outcome => { captured.value = capture(outcome.applied, item.instance.id); } : undefined);
            if (!result.ok) return result;
            const acknowledged = readPreference(surface, signal);
            if (!acknowledged) return unavailable;
            if (mutation.kind === 'add' && mutation.captureForMove) {
                const committed = captured.value;
                if (!committed) return { ok: false, errorCode: 'widgets_move_capture_unavailable', error: 'widgets_move_capture_unavailable' };
                return { ok: true, result: { ref: { surface, instanceId: item.instance.id }, instance: committed.expectedInstance, moveCapture: committed } };
            }
            const updated = acknowledged.items.find((candidate) => candidate.kind === 'instance' && candidate.instance.id === item.instance.id);
            return { ok: true, result: { ref: { surface, instanceId: item.instance.id }, instance: updated?.kind === 'instance' ? updated.instance : null } };
        },
    };
}
