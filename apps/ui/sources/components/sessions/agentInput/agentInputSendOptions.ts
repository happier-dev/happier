export type AgentInputSendOptions = Readonly<{
    forceImmediate?: boolean;
    deliveryIntent?: 'server_pending';
    structuredInputMetaOverrides?: Record<string, unknown>;
    inputTextOverride?: string;
}>;

export type AgentInputSendIntentOptions = Readonly<Pick<AgentInputSendOptions, 'forceImmediate' | 'deliveryIntent'>>;
