import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineSetupEffectError, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';

/** Daemon PATH/HOME reach env only after runuser drops to the verified sudo-origin user. */
export async function createMachineSetupDaemonUserRunner(input: Readonly<{
    username: string | null | undefined;
    context: Readonly<{ home: string; path: string }> | undefined;
    platform: NodeJS.Platform;
    sudoUsername: string | undefined;
    sudoUid: string | undefined;
    signal: AbortSignal;
    runNative: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
}>): Promise<(command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>> {
    // This is an OS account, including the locked daemon account, rather than
    // the separately authenticated administrator selected for an Ask prompt.
    const username = MachineRecipeStepV1Schema.options[0].shape.username.safeParse(input.username);
    if (input.platform !== 'linux' || !username.success || !input.context || input.sudoUsername !== username.data
        || !input.sudoUid || !/^[1-9]\d*$/.test(input.sudoUid) || !Number.isSafeInteger(Number(input.sudoUid))) {
        throw new MachineSetupEffectError('required_fact_unavailable');
    }
    input.signal.throwIfAborted();
    const uid = await input.runNative({ executable: 'id', args: ['-u', '--', username.data], signal: input.signal });
    if (uid.code !== 0 || uid.stdout.trim() !== input.sudoUid) throw new MachineSetupEffectError('required_fact_unavailable');
    const context = input.context;
    return async command => {
        input.signal.throwIfAborted();
        return input.runNative({ executable: 'runuser', args: ['-u', username.data, '--', 'env', '-i',
            `HOME=${context.home}`, `PATH=${context.path}`, `USER=${username.data}`, `LOGNAME=${username.data}`,
            ...Object.entries(command.env ?? {}).map(([name, value]) => `${name}=${value}`),
            command.executable, ...command.args,
        ], signal: input.signal, ...(command.inputBytes ? { inputBytes: command.inputBytes } : {}) });
    };
}
