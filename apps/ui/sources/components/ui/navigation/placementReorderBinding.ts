import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { EntityDragScopeV1, EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { NavigationSurfacePlacementsV1Schema, navigationPlacementPatch, readNavigationPlacementPreferences, reorderNavigationPlacement, type NavigationPlacementAddress, type NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import type { NavigationPlacementItem } from './NavigationPlacementCustomizer';

/** One reorder admission and write, for a placement list and for the preview that draws the same items. */
export function buildPlacementReorderBinding(input: Readonly<{
    scope: EntityDragScopeV1 | null;
    dragSurfaceId: string;
    axis?: 'horizontal' | 'vertical';
    items: readonly NavigationPlacementItem[];
    /** The ids a move may land among: its own group in a list, what is drawn in a preview. */
    moveIdsOf: (id: string) => readonly string[];
    orderedIds: readonly string[];
    preferences: NavigationPlacementPreferences;
    onChange: (preferences: NavigationPlacementPreferences) => void | Promise<boolean>;
}> & (
    | Readonly<{ address: NavigationPlacementAddress; setting?: never }>
    /** Another placement owner supplies its Action anchor and admitted value codec. */
    | Readonly<{ address?: never; setting: Readonly<{
        anchor: string;
        valueOf: (preferences: NavigationPlacementPreferences) => EntityDropEffectV1['input'];
        read: (value: unknown) => NavigationPlacementPreferences | null;
    }> }>
)): EntityFlatReorderBinding {
    const { items, scope } = input;
    return {
        scope,
        kind: 'navigation-item',
        items,
        getItem: id => scope && items.some(item => item.id === id)
            ? { kind: 'navigation-item', scope, surfaceId: input.dragSurfaceId, itemId: id } : null,
        getSourceId: item => item.kind === 'navigation-item' && item.surfaceId === input.dragSurfaceId ? item.itemId : null,
        resolve: (sourceId, position) => {
            const ids = input.moveIdsOf(sourceId);
            if (position.anchorId !== null && !ids.includes(position.anchorId)) return entityReorderRefused('same-position');
            const moved = resolveAnchoredListMoveV1(ids, sourceId, position);
            if (!moved || moved.every((id, index) => id === ids[index])) return entityReorderRefused('same-position');
            // The saved order stays one list across every group; the move only relocates this row beside its anchor.
            const next = reorderNavigationPlacement(input.preferences, [...input.orderedIds], sourceId, position);
            if (!next) return entityReorderRefused('reorder_target_gone');
            return { status: 'allowed', effect: { actionId: 'settings.set', input: {
                anchor: input.setting?.anchor ?? 'appearance.navigationPlacements', value: input.setting ? input.setting.valueOf(next) : navigationPlacementPatch(input.address, next),
            }, preview: entityReorderPreview(position, items, input.axis) } };
        },
        execute: async effect => {
            const payload = effect.input;
            if (effect.actionId !== 'settings.set' || !payload || typeof payload !== 'object' || Array.isArray(payload) || !('anchor' in payload) || payload.anchor !== (input.setting?.anchor ?? 'appearance.navigationPlacements')) {
                return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            }
            const parsed = input.setting ? null : NavigationSurfacePlacementsV1Schema.safeParse('value' in payload ? payload.value : undefined);
            const next = input.setting ? input.setting.read('value' in payload ? payload.value : undefined) : parsed?.success ? readNavigationPlacementPreferences(parsed.data, input.address) : null;
            if (!next) return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            const applied = await input.onChange(next);
            return applied === false
                ? { status: 'refused', reason: {
                    code: 'navigation_placement_not_applied',
                    message: resolveActionExecutionFailureMessage({ ok: false, errorCode: 'navigation_placement_not_applied' }, t('errors.operationFailed'))!,
                } }
                : { status: 'applied' };
        },
    };
}
