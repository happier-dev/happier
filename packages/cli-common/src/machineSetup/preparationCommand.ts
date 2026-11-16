import type { MachineSetupPreparationV1 } from '@happier-dev/protocol/machines/setup/machineSetupPreparationV1';
import { safeBashSingleQuote } from '../ssh/shellQuote.js';
import { buildRemoteHappierInvocationCommand } from '../systemTasks/ssh/remoteBootstrapCommandBuilder.js';

/** Execute as root inside the actual image after installing the supplied CLI.
 * Recipe compilation and native effects stay in the existing typed interpreter. */
export function buildMachineSetupPreparationCommandV1(input: Readonly<{
    binaryPath: string;
    preparation: MachineSetupPreparationV1;
}>): string {
    const frame = JSON.stringify({ v: 1, mode: 'apply', preparation: input.preparation });
    const invocation = buildRemoteHappierInvocationCommand({ binaryPath: input.binaryPath,
        args: ['machine', 'effect-internal', `--operation-id=${input.preparation.basis.operationId}`] });
    return `printf '%s\\n' ${safeBashSingleQuote(frame)} | ${invocation}`;
}
