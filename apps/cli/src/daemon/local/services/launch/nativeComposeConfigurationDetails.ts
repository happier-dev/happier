import type { MachineServiceNativeRuntimeFactsV1 } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';

type Configuration = NonNullable<MachineServiceNativeRuntimeFactsV1['configurationDetails']>[number];

/** The capture supplies validated container identity and its existing redactor. Raw environment values stay here. */
export function projectNativeComposeConfigurationDetails(input: Readonly<{
    nativeResourceId: string; nativeImageId?: string; networkNames?: readonly string[];
    config: Readonly<Record<string, unknown>>; networkMode?: string; redact(value: string): string;
}>): Configuration {
    const { config, redact } = input;
    const argv = (value: unknown) => value === null ? []
        : Array.isArray(value) && value.every(part => typeof part === 'string') ? value.map(redact) : null;
    const entrypoint = argv(config.Entrypoint);
    const command = argv(config.Cmd);
    const environment = Array.isArray(config.Env) && config.Env.every(value => typeof value === 'string') ? config.Env : null;
    const health = config.Healthcheck !== null && typeof config.Healthcheck === 'object' && !Array.isArray(config.Healthcheck)
        ? config.Healthcheck as Readonly<Record<string, unknown>> : null;
    const test = health ? argv(health.Test) : null;
    return {
        nativeResourceId: input.nativeResourceId,
        image: typeof config.Image === 'string' ? redact(config.Image) : null,
        imageDigest: input.nativeImageId ?? null,
        command: entrypoint && command ? [...entrypoint, ...command] : null,
        networks: input.networkNames?.map(redact) ?? null,
        networkMode: input.networkMode === undefined ? null : redact(input.networkMode),
        variableNames: environment ? [...new Set(environment.map(value => redact(value.split('=', 1)[0]!)))].sort() : null,
        healthcheck: test?.length && test[0] !== 'NONE' ? { test,
            intervalNs: typeof health?.Interval === 'number' && Number.isSafeInteger(health.Interval) && health.Interval >= 0
                ? health.Interval : null } : null,
    };
}
