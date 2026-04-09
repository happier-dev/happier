import { output as cliOutput } from '@happier-dev/cli-common';
import { cmd as renderCmd } from '@happier-dev/cli-common/output';

import { collectSupportMaintenanceContext, type SupportMaintenanceContext } from '../runtime/collectSupportMaintenanceContext.js';
import {
    defaultRunSupportCommand,
    executeSupportDelegatedActions,
    rewriteLeadingCliCommand,
    type SupportCommandRunnerResult,
    type SupportDelegatedAction,
} from './supportCliDelegation.js';

export type CleanupSupportCommandResult = Readonly<{
    output: string;
    executed: boolean;
}>;

export type CleanupSupportCommandDeps = Readonly<{
    collectMaintenanceContext?: () => Promise<SupportMaintenanceContext> | SupportMaintenanceContext;
    runCommand?: (input: Readonly<{ cmd: string; args: readonly string[] }>) => Promise<SupportCommandRunnerResult> | SupportCommandRunnerResult;
    presentation?: cliOutput.OutputPresentation;
}>;

const WARNING_CODES_WITH_EXECUTABLE_SERVICE_REPAIR = new Set([
    'DAEMON_STARTED_WITH_DIFFERENT_CLI',
    'ORPHAN_DAEMON_SERVICE',
    'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
    'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER',
    'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT',
    'LEGACY_PINNED_DAEMON_SERVICE',
]);

function resolveCleanupCommand(
    warning: SupportMaintenanceContext['warnings'][number],
    preferredCliCommand: SupportMaintenanceContext['preferredCliCommand'],
): string {
    if (WARNING_CODES_WITH_EXECUTABLE_SERVICE_REPAIR.has(warning.code)) {
        return rewriteLeadingCliCommand('happier service repair --yes', preferredCliCommand);
    }

    return warning.details?.[0] ? rewriteLeadingCliCommand(String(warning.details[0]), preferredCliCommand) : '';
}

function buildCleanupActions(context: SupportMaintenanceContext): SupportDelegatedAction[] {
    const seen = new Set<string>();
    const actions: Array<{ command: string; reason: string }> = [];
    for (const warning of context.warnings) {
        const preferredCommand = resolveCleanupCommand(warning, context.preferredCliCommand);
        const command = preferredCommand.trim();
        if (!command || seen.has(command)) continue;
        seen.add(command);
        actions.push({
            command,
            reason: warning.code,
        });
    }
    return actions;
}

function renderCleanupPreview(actions: readonly SupportDelegatedAction[], presentation?: cliOutput.OutputPresentation): string {
    const builder = cliOutput.createOutputBuilder({ presentation });
    builder.line(
        presentation?.banner
            ? presentation.banner('Support cleanup', { subtitle: `${actions.length} action(s)` })
            : `Support cleanup\n${actions.length} action(s)`,
    );
    builder.blank();
    builder.section('Actions', (section) => {
        section.bullets(actions.map((action) => `${action.reason}: ${action.command}`));
    });
    if (actions.length > 0) {
        builder.line(`Re-run with ${renderCmd('--yes')} to apply.`);
    }
    return `${builder.render()}\n`;
}

export async function runCleanupSupportCommand(
    input: Readonly<{ json: boolean; yes: boolean }>,
    deps: CleanupSupportCommandDeps = {},
): Promise<CleanupSupportCommandResult> {
    const context = await (deps.collectMaintenanceContext ?? collectSupportMaintenanceContext)();
    const actions = buildCleanupActions(context);
    if (!input.yes) {
        const output = input.json
            ? `${JSON.stringify({ ok: true, executed: false, actions }, null, 2)}\n`
            : renderCleanupPreview(actions, deps.presentation);
        return { output, executed: false };
    }

    await executeSupportDelegatedActions(actions, deps.runCommand ?? defaultRunSupportCommand);

    const output = `${JSON.stringify({ ok: true, executed: true, actions }, null, 2)}\n`;
    return { output, executed: true };
}
