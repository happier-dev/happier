import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';
import type { NewSessionAfterSendMode } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { t } from '@/text';

export type AgentInputSendOptions = Readonly<{
    forceImmediate?: boolean;
    sendNextQueued?: boolean;
    deliveryIntent?: MessageSendMode;
    /** New-session composer: what follows this Send, overriding the "After sending" setting. */
    afterSend?: NewSessionAfterSendMode;
    structuredInputMetaOverrides?: Record<string, unknown>;
    inputTextOverride?: string;
}>;

export type AgentInputSendIntentOptions = Readonly<Pick<AgentInputSendOptions, 'forceImmediate' | 'deliveryIntent' | 'afterSend'>>;

export type AgentInputSendMenuItem = Readonly<{
    id: string;
    title: string;
    shortcut?: string;
    options: AgentInputSendIntentOptions;
}>;

function getSendModeTitle(mode: MessageSendMode): string {
    return mode === 'agent_queue' ? t('session.pendingMessages.actions.steerNow')
        : mode === 'interrupt' ? t('session.pendingMessages.actions.sendNowInterrupt') : t('agentInput.sendOptions.queue');
}

/** The one list behind the send menu and its tooltip: delivery modes in a Session, what follows in a new one. */
export function buildAgentInputSendMenuItems(input: Readonly<{
    modes?: readonly MessageSendMode[];
    shortcuts?: Partial<Record<MessageSendMode, string>>;
    newSessionAfterSendMode?: NewSessionAfterSendMode;
    afterSendShortcut?: string;
}>): readonly AgentInputSendMenuItem[] {
    if (input.newSessionAfterSendMode) {
        const afterSend: NewSessionAfterSendMode = input.newSessionAfterSendMode === 'open' ? 'startAnother' : 'open';
        return [{
            id: afterSend,
            title: t(afterSend === 'startAnother' ? 'agentInput.sendOptions.sendAndStartAnother' : 'agentInput.sendOptions.sendAndOpen'),
            shortcut: input.afterSendShortcut,
            options: { afterSend },
        }];
    }
    return (input.modes ?? []).map((mode) => ({
        id: mode,
        title: getSendModeTitle(mode),
        shortcut: input.shortcuts?.[mode],
        options: { deliveryIntent: mode },
    }));
}
