import type { PluginDiagnosticData } from '../diagnostics.js';
import { PluginError } from '../errors.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginServiceId, PluginServices } from '../services/index.js';

export type PluginServiceReferenceOperationContext = Readonly<{
    signal?: AbortSignal;
}>;

export type PluginServiceReferenceAdapter = Readonly<{
    invoke<T>(
        serviceId: PluginServiceId,
        operation: (
            context: PluginServiceReferenceOperationContext,
        ) => T | Promise<T>,
        options?: PluginServiceReferenceOperationContext,
    ): Promise<T>;
    dispose(serviceId: PluginServiceId, disposable: Disposable): Promise<void>;
}>;

export type PluginServiceReferenceAdapterOptions = Readonly<{
    onDiagnostic?: (
        diagnostic: PluginDiagnosticData,
    ) => void | Promise<void>;
}>;

type PluginServiceAvailabilityReader = Pick<PluginServices, 'availability'>;

function cancellationError(serviceId: PluginServiceId): PluginError {
    const diagnostic: PluginDiagnosticData = {
        code: 'plugin_operation_cancelled',
        severity: 'warning',
        details: { serviceId },
    };
    return new PluginError({
        code: diagnostic.code,
        retryable: false,
        details: diagnostic.details,
        diagnostics: [diagnostic],
    });
}

function unavailableError(
    serviceId: PluginServiceId,
    availability: Exclude<
        ReturnType<PluginServices['availability']>,
        { status: 'available' }
    >,
): PluginError {
    const details = {
        serviceId,
        availability: availability.status,
    } as const;
    const diagnostic: PluginDiagnosticData = {
        code: availability.code,
        severity: availability.status === 'denied' ? 'warning' : 'error',
        details,
        ...(availability.remediation === undefined
            ? {}
            : { remediation: availability.remediation }),
    };
    return new PluginError({
        code: availability.code,
        retryable: false,
        details,
        ...(availability.remediation === undefined
            ? {}
            : { remediation: availability.remediation }),
        diagnostics: [diagnostic],
    });
}

function normalizedFailure(
    serviceId: PluginServiceId,
    code: 'plugin_service_operation_failed' | 'plugin_service_disposal_failed',
    cause: unknown,
): PluginError {
    if (cause instanceof PluginError) return cause;
    const diagnostic: PluginDiagnosticData = {
        code,
        severity: 'error',
        details: { serviceId },
    };
    return new PluginError({
        code,
        retryable: false,
        details: diagnostic.details,
        diagnostics: [diagnostic],
    }, { cause });
}

/**
 * Executable contract reference for SDK fixtures.
 *
 * This adapter intentionally implements no host policy or service behavior. It
 * only demonstrates the shared availability, cancellation, cleanup, error, and
 * diagnostic boundary that real WS2/WS6 service implementations must preserve.
 */
export function createPluginServiceReferenceAdapter(
    services: PluginServiceAvailabilityReader,
    options: PluginServiceReferenceAdapterOptions = {},
): PluginServiceReferenceAdapter {
    const observe = (error: PluginError): void => {
        for (const diagnostic of error.diagnostics ?? []) {
            try {
                const observation = options.onDiagnostic?.(diagnostic);
                if (observation !== undefined) {
                    void Promise.resolve(observation).catch(() => {
                        // Reference observation must not replace the canonical failure.
                    });
                }
            } catch {
                // Reference observation must not replace the canonical failure.
            }
        }
    };

    const invoke = async <T>(
        serviceId: PluginServiceId,
        operation: (
            context: PluginServiceReferenceOperationContext,
        ) => T | Promise<T>,
        operationOptions: PluginServiceReferenceOperationContext = {},
    ): Promise<T> => {
        try {
            if (operationOptions.signal?.aborted === true) {
                throw cancellationError(serviceId);
            }
            const availability = services.availability(serviceId);
            if (availability.status !== 'available') {
                throw unavailableError(serviceId, availability);
            }
            return await operation(operationOptions);
        } catch (cause) {
            const error = normalizedFailure(
                serviceId,
                'plugin_service_operation_failed',
                cause,
            );
            observe(error);
            throw error;
        }
    };

    const dispose = async (
        serviceId: PluginServiceId,
        disposable: Disposable,
    ): Promise<void> => {
        try {
            await disposable.dispose();
        } catch (cause) {
            const error = normalizedFailure(
                serviceId,
                'plugin_service_disposal_failed',
                cause,
            );
            observe(error);
            throw error;
        }
    };

    return Object.freeze({ invoke, dispose });
}
