import { parseBooleanEnv, parseIntEnv } from "./env";

type EnvLike = Record<string, string | undefined>;

export const DEFAULT_METRICS_PORT = 9090;

export function readMetricsServerConfigFromEnv(env: EnvLike): Readonly<{
    enabled: boolean;
    port: number;
}> {
    return {
        enabled: parseBooleanEnv(env.METRICS_ENABLED, true),
        port: parseIntEnv(env.METRICS_PORT, DEFAULT_METRICS_PORT, { min: 0, max: 65_535 }),
    };
}
