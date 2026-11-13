import type { IosSimulatorAdapterUnavailableReasonV1 } from '@happier-dev/protocol';

export type IosSimulatorXcodeCommandResult = Readonly<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
}>;

export type IosSimulatorXcodeCommandRunner = (
    input: Readonly<{ command: string; args: readonly string[]; timeoutMs: number }>,
) => Promise<IosSimulatorXcodeCommandResult>;

export type IosSimulatorXcodeEnvironment = Readonly<
    | {
        ok: true;
    }
    | {
        ok: false;
        reasonCode: Extract<
            IosSimulatorAdapterUnavailableReasonV1,
            'unsupported_host' | 'xcode_unavailable'
        >;
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type ResolveIosSimulatorXcodeEnvironmentInput = Readonly<{
    platform?: NodeJS.Platform | string;
    runCommand: IosSimulatorXcodeCommandRunner;
    timeoutMs?: number;
}>;

function unavailable(
    reasonCode: Extract<IosSimulatorXcodeEnvironment, { ok: false }>['reasonCode'],
    diagnostics: readonly Record<string, unknown>[] = [],
): IosSimulatorXcodeEnvironment {
    return { ok: false, reasonCode, diagnostics };
}

export async function resolveIosSimulatorXcodeEnvironment(
    input: ResolveIosSimulatorXcodeEnvironmentInput,
): Promise<IosSimulatorXcodeEnvironment> {
    const platform = input.platform ?? process.platform;
    if (platform !== 'darwin') {
        return unavailable('unsupported_host', [{
            code: 'unsupported_host',
            platform,
        }]);
    }

    const result = await input.runCommand({
        command: 'xcrun',
        args: ['--find', 'simctl'],
        timeoutMs: input.timeoutMs ?? 5_000,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
        return unavailable('xcode_unavailable', [{
            code: 'simctl_resolution_failed',
            exitCode: result.exitCode,
        }]);
    }

    // Apple tooling owns the selected Xcode/CoreSimulator layout (and DEVELOPER_DIR).
    // Framework loading is the capture helper's health contract, not a discovery prerequisite.
    return { ok: true };
}
