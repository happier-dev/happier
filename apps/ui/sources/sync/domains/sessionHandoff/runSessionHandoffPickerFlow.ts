import type { ActionExecutorContext, ActionUiPlacement } from '@happier-dev/protocol';

import { openSessionHandoffPicker } from '@/components/sessions/handoff/openSessionHandoffPicker';
import { Modal } from '@/modal';
import { t } from '@/text';

import { readSessionHandoffSessionActivity } from './readSessionHandoffSessionActivity';
import { runSessionHandoffUiFlow, type RunSessionHandoffUiFlowResult } from './runSessionHandoffUiFlow';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<unknown>;

async function confirmActiveSessionHandoff(sessionId: string): Promise<boolean> {
    if (readSessionHandoffSessionActivity(sessionId)?.active !== true) {
        return true;
    }

    return await Modal.confirm(
        t('sessionHandoff.activeWarning.title'),
        t('sessionHandoff.activeWarning.message'),
        {
            cancelText: t('common.cancel'),
            confirmText: t('sessionHandoff.activeWarning.confirm'),
            destructive: true,
        },
    );
}

export async function runSessionHandoffPickerFlow(args: Readonly<{
    execute: ExecuteAction;
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    placement: ActionUiPlacement;
}>): Promise<RunSessionHandoffUiFlowResult | null> {
    const selection = await openSessionHandoffPicker({
        sessionId: args.sessionId,
        sourceMachineId: args.sourceMachineId ?? null,
        serverId: args.serverId,
    });
    if (!selection) {
        return null;
    }
    if (!await confirmActiveSessionHandoff(args.sessionId)) {
        return { ok: false, handled: true };
    }
    return await runSessionHandoffUiFlow({
        execute: args.execute,
        sessionId: args.sessionId,
        targetMachineId: selection.targetMachineId,
        targetSessionStorageMode: selection.targetSessionStorageMode,
        workspaceTransfer: selection.workspaceTransfer,
        context: {
            defaultSessionId: args.sessionId,
            serverId: args.serverId,
            surface: 'ui_button',
            placement: args.placement,
        },
    });
}
