import { IosSimulatorAdapterHealthV1Schema, type IosSimulatorAdapterHealthV1 } from '@happier-dev/protocol';

import { createIosSimulatorUnavailableHealth } from './diagnostics';

export type IosSimulatorHelperProbeRunResult = Readonly<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
}>;

export type IosSimulatorHelperProbeRunner = (
    input: Readonly<{ helperPath: string; args: readonly string[]; timeoutMs: number }>,
) => Promise<IosSimulatorHelperProbeRunResult>;

export type ProbeIosSimulatorHelperHealthInput = Readonly<{
    helperPath: string;
    runHelper: IosSimulatorHelperProbeRunner;
    timeoutMs?: number;
}>;

function unavailable(
    code: string,
    details: Record<string, unknown> = {},
): IosSimulatorAdapterHealthV1 {
    return createIosSimulatorUnavailableHealth({
        reasonCode: 'ios_private_helper_unavailable',
        diagnostics: [{
            code,
            ...details,
        }],
    });
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

export async function probeIosSimulatorHelperHealth(
    input: ProbeIosSimulatorHelperHealthInput,
): Promise<IosSimulatorAdapterHealthV1> {
    let result: IosSimulatorHelperProbeRunResult;
    try {
        result = await input.runHelper({
            helperPath: input.helperPath,
            args: ['--health-json'],
            timeoutMs: input.timeoutMs ?? 5_000,
        });
    } catch (error) {
        return unavailable('helper_health_probe_failed', {
            errorName: errorName(error),
        });
    }

    if (result.exitCode !== 0) {
        return unavailable('helper_health_probe_failed', {
            exitCode: result.exitCode,
        });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (error) {
        return unavailable('helper_health_malformed_output', {
            errorName: errorName(error),
        });
    }

    const health = IosSimulatorAdapterHealthV1Schema.safeParse(parsed);
    if (!health.success) {
        return unavailable('helper_health_malformed_output', {
            issueCount: health.error.issues.length,
        });
    }
    return health.data;
}
