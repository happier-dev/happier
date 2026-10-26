import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';

export type AgentInputSendOptions = Readonly<{
    forceImmediate?: boolean;
    sendNextQueued?: boolean;
    deliveryIntent?: MessageSendMode;
    structuredInputMetaOverrides?: Record<string, unknown>;
    inputTextOverride?: string;
}>;

export type AgentInputSendIntentOptions = Readonly<Pick<AgentInputSendOptions, 'forceImmediate' | 'deliveryIntent'>>;
