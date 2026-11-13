import { z } from 'zod/mini';
import { carryActionFailureDiagnostic, invalidActionOutputFailure } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type PluginAvailabilityResponsePhase = 'materializations' | 'intent_census' | 'intent_identity';

/** Invalid response bytes cannot recover with time; a real Availability change can retry. */
export class PluginAvailabilityInvalidResponseError extends Error {
    readonly code = 'plugin_availability_invalid_response';
    readonly retryable = false;

    constructor(readonly phase: PluginAvailabilityResponsePhase, readonly scope: ServerAccountScope) {
        super(`Plugin Availability returned an invalid ${phase} response.`);
        this.name = 'PluginAvailabilityInvalidResponseError';
    }
}

/** A failed HTTP/transport read settles acquisition without disabling the existing retry owner. */
export class PluginAvailabilityUnavailableError extends Error {
    readonly code = 'plugin_availability_unavailable';
    readonly retryable = true;

    constructor(readonly phase: PluginAvailabilityResponsePhase, readonly scope: ServerAccountScope,
        readonly status?: number) {
        super(status === undefined ? `Plugin Availability ${phase} request failed.`
            : `Plugin Availability ${phase} request failed with status ${status}.`);
        this.name = 'PluginAvailabilityUnavailableError';
    }
}

export type PluginAvailabilityResponseFailure = PluginAvailabilityInvalidResponseError | PluginAvailabilityUnavailableError;

export function isPluginAvailabilityResponseFailure(error: unknown): error is PluginAvailabilityResponseFailure {
    return error instanceof PluginAvailabilityInvalidResponseError || error instanceof PluginAvailabilityUnavailableError;
}

export function parsePluginAvailabilityResponse<T>(
    schema: Readonly<{ parse: (value: unknown) => T }>,
    value: unknown,
    phase: PluginAvailabilityResponsePhase,
    scope: ServerAccountScope,
): T {
    try {
        return schema.parse(value);
    } catch (error) {
        if (error instanceof z.core.$ZodError) throw carryActionFailureDiagnostic(
            new PluginAvailabilityInvalidResponseError(phase, scope),
            invalidActionOutputFailure(error, `plugin_availability.${phase}`, undefined, { issuePaths: 'omit' }),
        );
        throw error;
    }
}
