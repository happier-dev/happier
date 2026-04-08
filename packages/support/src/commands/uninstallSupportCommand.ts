import { collectSupportMaintenanceContext, type SupportMaintenanceContext } from '../runtime/collectSupportMaintenanceContext.js';
import {
    defaultRunSupportCommand,
    executeSupportDelegatedActions,
    rewriteLeadingCliCommand,
    type SupportCommandRunnerResult,
} from './supportCliDelegation.js';

export type UninstallSupportCommandResult = Readonly<{
    output: string;
    executed: boolean;
}>;

export type UninstallSupportCommandDeps = Readonly<{
    collectMaintenanceContext?: () => Promise<SupportMaintenanceContext> | SupportMaintenanceContext;
    runCommand?: (input: Readonly<{ cmd: string; args: readonly string[] }>) => Promise<SupportCommandRunnerResult> | SupportCommandRunnerResult;
}>;

function buildUninstallCommand(input: Readonly<{
    preferredCliCommand: 'happier' | 'hprev' | 'hdev' | null;
    dryRun: boolean;
    keepService: boolean;
}>): string {
    if (!input.preferredCliCommand) {
        throw new Error('Could not find a Happier CLI shim on PATH to delegate uninstall.');
    }

    const command = rewriteLeadingCliCommand('happier uninstall', input.preferredCliCommand);
    const flags = [
        '--yes',
        input.dryRun ? '--dry-run' : '',
        input.keepService ? '--keep-service' : '',
    ].filter(Boolean);
    return [command, ...flags].join(' ');
}

export async function runUninstallSupportCommand(
    input: Readonly<{ json: boolean; yes: boolean; dryRun: boolean; keepService: boolean }>,
    deps: UninstallSupportCommandDeps = {},
): Promise<UninstallSupportCommandResult> {
    const context = await (deps.collectMaintenanceContext ?? collectSupportMaintenanceContext)();
    const actions = [{
        command: buildUninstallCommand({
            preferredCliCommand: context.preferredCliCommand,
            dryRun: input.dryRun,
            keepService: input.keepService,
        }),
        reason: 'current-managed-installation',
    }];

    if (!input.yes) {
        const output = `${JSON.stringify({ ok: true, executed: false, actions }, null, 2)}\n`;
        return { output, executed: false };
    }

    await executeSupportDelegatedActions(actions, deps.runCommand ?? defaultRunSupportCommand);
    const output = `${JSON.stringify({ ok: true, executed: true, actions }, null, 2)}\n`;
    return { output, executed: true };
}
