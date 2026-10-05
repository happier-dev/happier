import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readSessionPresentationAdapterAtAddress } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { isUnreadableSessionCompanionPreference, normalizeSessionCompanionPreference } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { readSessionCompanionPreferenceSlotFromState, storage } from '@/sync/domains/state/storage';
import { createWidgetCompanionActionPortV1 } from '@/sync/domains/widgets/widgetCompanionActionPort';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Generic widget Actions borrow the current UI presentation owner, never a local reducer writer. */
export function createWidgetCompanionActionDepsV1(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'accountLifetime' | 'assertCurrent'>): Pick<ActionExecutorDeps, 'widgetSurfaceActions'> {
    if (!account.accountLifetime) return {};
    const companion = createWidgetCompanionActionPortV1({
        lifetime: account.accountLifetime,
        readPreference: surface => {
            account.assertCurrent();
            if (surface.owner.kind !== 'companion'
                || !readSessionPresentationAdapterAtAddress({ serverId: surface.serverId, sessionId: surface.owner.sessionId })) return null;
            const slot = readSessionCompanionPreferenceSlotFromState(storage.getState(), surface.owner.sessionId, account.serverId, surface.serverId);
            if (!slot.storageKey || isUnreadableSessionCompanionPreference(slot.stored)) return null;
            return normalizeSessionCompanionPreference(slot.stored);
        },
        applyPresentation: async (surface, intent, _context, signal, onCompanionMutation) => {
            account.assertCurrent();
            const adapter = surface.owner.kind === 'companion' && !signal?.aborted
                ? readSessionPresentationAdapterAtAddress({ serverId: surface.serverId, sessionId: surface.owner.sessionId }) : null;
            const result = adapter?.apply(intent, onCompanionMutation);
            account.assertCurrent();
            if (result?.status === 'invalidTarget' && intent.kind === 'companion.item.remove' && intent.expectedInstance) {
                return { ok: false, errorCode: 'widgets_move_conflict', error: 'widgets_move_conflict' };
            }
            return result?.status === 'applied' || result?.status === 'unchanged'
                ? { ok: true, result }
                : { ok: false, errorCode: 'widgets_surface_unavailable', error: 'widgets_surface_unavailable' };
        },
    });
    return { widgetSurfaceActions: { companion } };
}
