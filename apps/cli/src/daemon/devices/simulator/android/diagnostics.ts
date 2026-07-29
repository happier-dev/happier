import {
    AndroidSimulatorAdapterHealthV1Schema,
    type AndroidSimulatorAdapterHealthV1,
    type AndroidSimulatorAdapterUnavailableReasonV1,
} from '@happier-dev/protocol';

export function createAndroidSimulatorUnavailableHealth(input: Readonly<{
    reasonCode: AndroidSimulatorAdapterUnavailableReasonV1;
    diagnostics?: readonly Record<string, unknown>[];
}>): AndroidSimulatorAdapterHealthV1 {
    return AndroidSimulatorAdapterHealthV1Schema.parse({
        v: 1,
        platform: 'android',
        status: 'unavailable',
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    });
}
