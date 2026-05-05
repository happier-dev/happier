export type AcpPromptImageSupportV1 = 'yes' | 'no' | 'unknown';
export type AcpCapabilitySupportHintV1 = 'yes' | 'no' | 'unknown';

export type AcpCapabilityFlagsV1 = Readonly<{
    supportsResume?: boolean;
    supportsStreaming?: boolean;
    supportsToolUse?: boolean;
    supportsPermissionRequests?: boolean;
    supportsInFlightSteer?: boolean;
    supportsModelSwitch?: boolean;
    customMessageKinds?: readonly string[];
    supportsLoadSession?: boolean;
    supportsModes?: boolean | AcpCapabilitySupportHintV1;
    supportsModels?: boolean | AcpCapabilitySupportHintV1;
    supportsConfigOptions?: boolean | AcpCapabilitySupportHintV1;
    supportsPromptImages?: boolean | 'unknown';
    promptImageSupport?: AcpPromptImageSupportV1;
}>;
