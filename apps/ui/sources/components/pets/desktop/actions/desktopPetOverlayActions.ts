import type {
    ActionExecuteResult,
    ActionExecutorContext,
    ActionId,
} from '@happier-dev/protocol';

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
        targetSessionId: string;
    }>) => void | Promise<void>;
}>): Promise<ActionExecuteResult> {
    const context: ActionExecutorContext = { defaultSessionId: params.item.sessionId };
    const result = await params.executor.execute(
        'session.open',
        { sessionId: params.item.sessionId },
        context,
    );
    if (result.ok) {
        await params.showMainWindow({
            reason: 'tray-action',
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
        { sessionId: params.item.sessionId, message },
        { defaultSessionId: params.item.sessionId },
    );
}

export function tuckDesktopPetOverlay(params: Readonly<{
    applyLocalSettings: (delta: Partial<LocalSettings>) => void;
}>): void {
    params.applyLocalSettings({
        desktopPetOverlayEnabledOverride: 'disabled',
    });
}
