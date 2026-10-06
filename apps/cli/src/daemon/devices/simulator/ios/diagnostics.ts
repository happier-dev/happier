import { IosSimulatorAdapterHealthV1Schema } from '@happier-dev/protocol/devices/simulator/iosV1';
import type { IosSimulatorAdapterHealthV1, IosSimulatorAdapterUnavailableReasonV1 } from '@happier-dev/protocol';

export function createIosSimulatorUnavailableHealth(input: Readonly<{
    reasonCode: IosSimulatorAdapterUnavailableReasonV1;
    diagnostics?: readonly Record<string, unknown>[];
}>): IosSimulatorAdapterHealthV1 {
    return IosSimulatorAdapterHealthV1Schema.parse({
        v: 1,
        platform: 'ios',
        status: 'unavailable',
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    });
}
