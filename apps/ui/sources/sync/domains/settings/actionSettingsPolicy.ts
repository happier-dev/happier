import type { ActionId } from '@happier-dev/protocol';

const INVENTORY_PRIVACY_ACTION_IDS = new Set<ActionId>([
    'paths.list_recent',
    'machines.list',
    'servers.list',
]);

export function isInventoryPrivacyAction(actionId: ActionId): boolean {
    return INVENTORY_PRIVACY_ACTION_IDS.has(actionId);
}
