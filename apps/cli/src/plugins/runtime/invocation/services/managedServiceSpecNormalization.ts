import { PluginError } from '@happier-dev/plugin-sdk';
import {
    ManagedServiceLocalIdSchema,
    normalizeProviderPublicHeaders,
} from '@happier-dev/protocol';
import type {
    ManagedServiceHealthCheck,
    ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

export const MANAGED_SERVICE_NUMERIC_CONTRACT = Object.freeze({
    startupTimeoutMs: Object.freeze({
        defaultValue: 30_000,
        minimum: 1,
        maximum: 300_000,
    }),
    healthTimeoutMs: Object.freeze({
        defaultValue: 5_000,
        minimum: 1,
        maximum: 60_000,
    }),
    healthIntervalMs: Object.freeze({
        defaultValue: 5_000,
        minimum: 250,
        maximum: 300_000,
    }),
    consecutiveFailures: Object.freeze({
        defaultValue: 2,
        minimum: 1,
        maximum: 20,
    }),
    durableLogKeepCount: Object.freeze({
        defaultValue: 50,
        minimum: 1,
        maximum: 50,
    }),
});

type NormalizedManagedServiceHealthCheck =
    | Extract<ManagedServiceHealthCheck, Readonly<{ kind: 'none' }>>
    | Readonly<
        Omit<
            Extract<ManagedServiceHealthCheck, Readonly<{ kind: 'http' }>>,
            'timeoutMs'
        > & { timeoutMs: number }
    >
    | Readonly<
        Omit<
            Extract<ManagedServiceHealthCheck, Readonly<{ kind: 'command' }>>,
            'timeoutMs'
        > & { timeoutMs: number }
    >;

type NormalizedManagedServiceCommon = Readonly<{
    startupTimeoutMs: number;
    healthPolicy: Readonly<{
        intervalMs: number;
        consecutiveFailures: number;
    }>;
    healthCheck?: NormalizedManagedServiceHealthCheck;
}>;

type NormalizeManagedServiceVariant<Spec extends ManagedServiceSpec> =
    Spec extends Readonly<{ mode: Readonly<{ kind: 'spawn' }> }>
        ? Readonly<
            Omit<
                Spec,
                | 'startupTimeoutMs'
                | 'healthPolicy'
                | 'healthCheck'
                | 'durableLog'
            >
            & NormalizedManagedServiceCommon
            & {
                durableLog?: Readonly<{
                    enabled: boolean;
                    keepCount: number;
                }>;
            }
        >
        : Readonly<
            Omit<
                Spec,
                | 'startupTimeoutMs'
                | 'healthPolicy'
                | 'healthCheck'
                | 'durableLog'
            >
            & NormalizedManagedServiceCommon
            & { durableLog?: never }
        >;

export type NormalizedManagedServiceSpec =
    NormalizeManagedServiceVariant<ManagedServiceSpec>;

function specInvalid(message: string): never {
    throw new PluginError({
        code: 'plugin_managed_service_spec_invalid',
        message,
    });
}

function validatedBoundedInteger(
    value: number | undefined,
    fallback: number,
    bounds: Readonly<{
        minimum: number;
        maximum: number;
    }>,
    label: string,
): number {
    const resolved = value ?? fallback;
    if (
        !Number.isSafeInteger(resolved)
        || resolved < bounds.minimum
        || resolved > bounds.maximum
    ) {
        return specInvalid(
            `${label} must be an integer between ${bounds.minimum} and ${bounds.maximum}`,
        );
    }
    return resolved;
}

/**
 * Static health headers are ordinary public request headers authored in the
 * managed-service specification. They reach the same supervisor fetch as the
 * plugin's own managed-service requests, so they use the one canonical
 * public-header contract: transport-owned and credential-bearing names are
 * refused, values and counts are bounded, and names are canonicalized. Host
 * credentials are merged after this normalization by their own owner.
 */
function normalizedStaticHealthHeaders(
    headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
    try {
        return normalizeProviderPublicHeaders(headers);
    } catch {
        return specInvalid(
            'Managed-service health-check headers are invalid',
        );
    }
}

export function normalizeManagedServiceHealthyWaitTimeout(
    timeoutMs: number | undefined,
    startupTimeoutMs: number,
): number {
    return validatedBoundedInteger(
        timeoutMs,
        startupTimeoutMs,
        MANAGED_SERVICE_NUMERIC_CONTRACT.startupTimeoutMs,
        'Managed-service healthy-wait timeout',
    );
}

export function normalizeManagedServiceSpec(
    spec: ManagedServiceSpec,
): NormalizedManagedServiceSpec {
    if (!ManagedServiceLocalIdSchema.safeParse(spec.id).success) {
        return specInvalid('Managed-service id is invalid');
    }
    if (spec.mode.kind === 'attach' && spec.durableLog !== undefined) {
        return specInvalid(
            'Managed-service attach mode cannot configure durable logging',
        );
    }
    const startupTimeoutMs = validatedBoundedInteger(
        spec.startupTimeoutMs,
        MANAGED_SERVICE_NUMERIC_CONTRACT.startupTimeoutMs.defaultValue,
        MANAGED_SERVICE_NUMERIC_CONTRACT.startupTimeoutMs,
        'Managed-service startup timeout',
    );
    const healthPolicy = Object.freeze({
        intervalMs: validatedBoundedInteger(
            spec.healthPolicy?.intervalMs,
            MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue,
            MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs,
            'Managed-service health interval',
        ),
        consecutiveFailures: validatedBoundedInteger(
            spec.healthPolicy?.consecutiveFailures,
            MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures.defaultValue,
            MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures,
            'Managed-service consecutive-failure count',
        ),
    });
    const healthCheck = !spec.healthCheck
        || spec.healthCheck.kind === 'none'
        ? spec.healthCheck
        : Object.freeze({
            ...spec.healthCheck,
            ...(spec.healthCheck.kind === 'http'
                && spec.healthCheck.headers !== undefined
                ? {
                    headers: normalizedStaticHealthHeaders(
                        spec.healthCheck.headers,
                    ),
                }
                : {}),
            timeoutMs: validatedBoundedInteger(
                spec.healthCheck.timeoutMs,
                MANAGED_SERVICE_NUMERIC_CONTRACT.healthTimeoutMs.defaultValue,
                MANAGED_SERVICE_NUMERIC_CONTRACT.healthTimeoutMs,
                'Managed-service health timeout',
            ),
        });
    if (spec.mode.kind === 'attach') {
        return Object.freeze({
            ...spec,
            startupTimeoutMs,
            healthPolicy,
            ...(healthCheck ? { healthCheck } : {}),
        }) as NormalizedManagedServiceSpec;
    }
    const durableLog = spec.durableLog
        ? Object.freeze({
            ...spec.durableLog,
            keepCount: validatedBoundedInteger(
                spec.durableLog.keepCount,
                MANAGED_SERVICE_NUMERIC_CONTRACT
                    .durableLogKeepCount.defaultValue,
                MANAGED_SERVICE_NUMERIC_CONTRACT.durableLogKeepCount,
                'Managed-service durable-log keep count',
            ),
        })
        : undefined;
    return Object.freeze({
        ...spec,
        startupTimeoutMs,
        healthPolicy,
        ...(healthCheck ? { healthCheck } : {}),
        ...(durableLog ? { durableLog } : {}),
    }) as NormalizedManagedServiceSpec;
}
