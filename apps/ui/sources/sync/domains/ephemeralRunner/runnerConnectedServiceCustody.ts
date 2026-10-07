import { ConnectedServiceBindingsV2Schema, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { classifyRunnerConnectedServiceSelectionV1, type RunnerConnectedServiceReviewBindingsV1 } from '@happier-dev/protocol/ephemeralRunner/runnerConnectedServices';

export class RunnerConnectedServiceIncompatibilityError extends Error {
    readonly code = 'runner_connected_service_not_portable' as const;

    constructor(readonly serviceKey: string, readonly source: string) {
        super(`Runner Connected Service '${serviceKey}' requires an unavailable scoped broker`);
        this.name = 'RunnerConnectedServiceIncompatibilityError';
    }
}

/** No Account reads: Lane 10 must supply scoped brokering before selections can travel. */
export async function resolveRunnerConnectedServiceReviewBindingsV1(input: Readonly<{
    bindings: ConnectedServiceBindingsV2;
    signal?: AbortSignal;
}>): Promise<RunnerConnectedServiceReviewBindingsV1> {
    input.signal?.throwIfAborted();
    const bindings = ConnectedServiceBindingsV2Schema.parse(input.bindings);
    for (const [serviceKey, selection] of Object.entries(bindings.bindingsByServiceId)) {
        if (classifyRunnerConnectedServiceSelectionV1(selection) === 'not_portable') {
            throw new RunnerConnectedServiceIncompatibilityError(serviceKey, selection.source);
        }
    }
    return { v: 1, bindings: [] };
}
