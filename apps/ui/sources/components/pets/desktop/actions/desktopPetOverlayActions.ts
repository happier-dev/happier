import type {
    ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type {
    ActionId,
} from '@happier-dev/protocol/actions/actionIds';

import type { PetCompanionTrayItem } from '@/components/pets/activity';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

export type DesktopPetOverlayActionExecutor = Readonly<{
    execute: (
        actionId: ActionId,
        input: unknown,
        context?: ActionExecutorContext,
    ) => Promise<ActionExecuteResult>;
}>;

export async function openDesktopPetOverlayTrayItem(params: Readonly<{
    item: PetCompanionTrayItem;
    executor: DesktopPetOverlayActionExecutor;
    showMainWindow: (payload: Readonly<{
        reason: 'tray-action';
        targetServerId: string;
        targetSessionId: string;
    }>) => void | Promise<void>;
}>): Promise<ActionExecuteResult> {
    const context: ActionExecutorContext = {
        defaultSessionId: params.item.address.sessionId,
        serverId: params.item.address.serverId,
    };
    const result = await params.executor.execute(
        'session.open',
        { sessionId: params.item.address.sessionId },
        context,
    );
    if (result.ok) {
        await params.showMainWindow({
            reason: 'tray-action',
            targetServerId: params.item.address.serverId,
            targetSessionId: params.item.sessionId,
        });
    }
    return result;
}

export async function sendDesktopPetOverlayQuickReply(params: Readonly<{
    item: PetCompanionTrayItem;
    message: string;
    executor: DesktopPetOverlayActionExecutor;
}>): Promise<ActionExecuteResult | null> {
    const message = params.message.trim();
    if (!message) return null;
    return params.executor.execute(
        'session.message.send',
        { sessionId: params.item.address.sessionId, message },
        {
            defaultSessionId: params.item.address.sessionId,
            serverId: params.item.address.serverId,
        },
    );
}

export function tuckDesktopPetOverlay(params: Readonly<{
    applyLocalSettings: (delta: Partial<LocalSettings>) => void;
}>): void {
    params.applyLocalSettings({
        desktopPetOverlayEnabledOverride: 'disabled',
    });
}
