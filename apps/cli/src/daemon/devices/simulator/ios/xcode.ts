import { join } from 'node:path';

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
        developerDir: string;
        privateFrameworks: Readonly<{
            CoreSimulator: string;
            SimulatorKit: string;
        }>;
    }
    | {
        ok: false;
        reasonCode: Extract<
            IosSimulatorAdapterUnavailableReasonV1,
            'unsupported_host' | 'xcode_unavailable' | 'xcode_private_frameworks_unavailable'
        >;
        diagnostics: readonly Record<string, unknown>[];
    }
>;

export type ResolveIosSimulatorXcodeEnvironmentInput = Readonly<{
    platform?: NodeJS.Platform | string;
    runCommand: IosSimulatorXcodeCommandRunner;
    pathExists: (path: string) => Promise<boolean>;
    timeoutMs?: number;
}>;

function privateFrameworkPath(developerDir: string, framework: 'CoreSimulator' | 'SimulatorKit'): string {
    return join(
        developerDir,
        'Platforms',
        'iPhoneSimulator.platform',
        'Developer',
        'Library',
        'PrivateFrameworks',
        `${framework}.framework`,
    );
}

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
        command: 'xcode-select',
        args: ['-p'],
        timeoutMs: input.timeoutMs ?? 5_000,
    });
    const developerDir = result.stdout.trim();
    if (result.exitCode !== 0 || !developerDir) {
        return unavailable('xcode_unavailable', [{
            code: 'xcode_select_failed',
            exitCode: result.exitCode,
        }]);
    }

    const coreSimulator = privateFrameworkPath(developerDir, 'CoreSimulator');
    const simulatorKit = privateFrameworkPath(developerDir, 'SimulatorKit');
    const [coreSimulatorExists, simulatorKitExists] = await Promise.all([
        input.pathExists(coreSimulator),
        input.pathExists(simulatorKit),
    ]);
    if (!coreSimulatorExists || !simulatorKitExists) {
        return unavailable('xcode_private_frameworks_unavailable', [{
            code: 'xcode_private_frameworks_unavailable',
            missing: [
                ...(!coreSimulatorExists ? ['CoreSimulator'] : []),
                ...(!simulatorKitExists ? ['SimulatorKit'] : []),
            ],
        }]);
    }

    return {
        ok: true,
        developerDir,
        privateFrameworks: {
            CoreSimulator: coreSimulator,
            SimulatorKit: simulatorKit,
        },
    };
}
