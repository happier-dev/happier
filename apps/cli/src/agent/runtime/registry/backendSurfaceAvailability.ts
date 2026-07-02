import type { BackendSurfaceAvailabilityV1 } from '@happier-dev/protocol';

export async function evaluateBackendSurfaceAvailability<TRequest>(
    evaluator: (request: TRequest) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>,
    request: TRequest,
): Promise<BackendSurfaceAvailabilityV1> {
    try {
        return await evaluator(request);
    } catch {
        return {
            available: false,
            reasonCode: 'evaluation_error',
        };
    }
}
