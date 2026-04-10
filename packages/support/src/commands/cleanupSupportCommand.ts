import * as cliHappierRuntime from '@happier-dev/cli-common/happierRuntime';
import * as cliOutput from '@happier-dev/cli-common/output';
import { cmd as renderCmd } from '@happier-dev/cli-common/output';

import { collectSupportMaintenanceContext, type SupportMaintenanceContext } from '../runtime/collectSupportMaintenanceContext.js';
import { renderSupportCleanupOwnershipSummary } from '../runtime/renderSupportCleanupOwnershipSummary.js';
import {
    rewriteLeadingCliCommand,
    type SupportDelegatedAction,
} from './supportCliDelegation.js';

export type CleanupSupportCommandResult = Readonly<{
    output: string;
    executed: boolean;
}>;

export type CleanupSupportCommandDeps = Readonly<{
    collectMaintenanceContext?: () => Promise<SupportMaintenanceContext> | SupportMaintenanceContext;
    presentation?: cliOutput.OutputPresentation;
}>;

const WARNING_CODES_WITH_BACKGROUND_SERVICE_CLEANUP = new Set([
    'ORPHAN_DAEMON_SERVICE',
    'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
    'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER',
    'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT',
    'LEGACY_PINNED_DAEMON_SERVICE',
]);
const WARNING_CODES_WITH_PATH_INSTALL_CLEANUP = new Set([
    'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
]);

type SupportCleanupExecutionResult = Readonly<{
    executedActions: readonly string[];
    manualActions: readonly SupportDelegatedAction[];
}>;

function resolveProcessUid(): number | null {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function buildRootRequiredManualAction(): SupportDelegatedAction {
    return {
        command: 'sudo npx @happier-dev/support cleanup --yes',
        reason: 'SYSTEM_BACKGROUND_SERVICE_REPAIR_REQUIRES_ROOT',
    };
}

function backgroundServiceCleanupActionRequiresRoot(
    action: cliHappierRuntime.BackgroundServiceRepairAction,
    processUid: number | null,
): boolean {
    return processUid !== null
        && processUid !== 0
        && (
            (action.kind === 'remove-service' && action.service.scope === 'system')
            || (action.kind === 'install-default-following-service' && action.mode === 'system')
        );
}

function resolveCleanupCommand(
    warning: SupportMaintenanceContext['warnings'][number],
    preferredCliCommand: SupportMaintenanceContext['preferredCliCommand'],
): string {
    return warning.details?.[0] ? rewriteLeadingCliCommand(String(warning.details[0]), preferredCliCommand) : '';
}

function buildManualCleanupActions(context: SupportMaintenanceContext): SupportDelegatedAction[] {
    const seen = new Set<string>();
    const actions: Array<{ command: string; reason: string }> = [];
    for (const warning of context.warnings) {
        if (
            WARNING_CODES_WITH_BACKGROUND_SERVICE_CLEANUP.has(warning.code)
            || WARNING_CODES_WITH_PATH_INSTALL_CLEANUP.has(warning.code)
        ) {
            continue;
        }
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

function buildPathInstallationCleanupPlan(
    context: SupportMaintenanceContext,
): cliHappierRuntime.PathInstallationCleanupPlan | null {
    const installations = context.installations ?? null;
    if (!installations) {
        return null;
    }
    const hasCleanupWarnings = context.warnings.some((warning) => WARNING_CODES_WITH_PATH_INSTALL_CLEANUP.has(warning.code));
    if (!hasCleanupWarnings) {
        return null;
    }
    return cliHappierRuntime.buildPathInstallationCleanupPlan({
        inventory: installations,
        services: context.services ?? [],
        keepService: false,
    });
}

function buildBackgroundServiceCleanupPlan(context: SupportMaintenanceContext): cliHappierRuntime.BackgroundServiceRepairPlan | null {
    const services = (context.services ?? []).filter((service) => service.serviceType === 'daemon');
    if (services.length === 0) {
        return null;
    }
    const warningCodes = new Set(context.warnings.map((warning) => warning.code));
    const hasCleanupWarnings = [...warningCodes].some((code) => WARNING_CODES_WITH_BACKGROUND_SERVICE_CLEANUP.has(code));
    if (!hasCleanupWarnings) {
        return null;
    }
    return cliHappierRuntime.buildBackgroundServiceRepairPlan({
        currentReleaseChannel: context.currentReleaseChannel,
        preferredMode: 'user',
        services,
    });
}

function buildDefaultServiceInstallManualAction(context: SupportMaintenanceContext): SupportDelegatedAction | null {
    const preferredCliCommand = context.preferredCliCommand ?? 'happier';
    return {
        command: rewriteLeadingCliCommand('happier service install --yes', preferredCliCommand),
        reason: 'INSTALL_DEFAULT_FOLLOWING_DAEMON_SERVICE',
    };
}

function buildCleanupPreviewActions(context: SupportMaintenanceContext): readonly SupportDelegatedAction[] {
    const actions: SupportDelegatedAction[] = [];
    const processUid = resolveProcessUid();
    let hasAddedRootManualAction = false;
    const addRootManualAction = (): void => {
        if (hasAddedRootManualAction) {
            return;
        }
        actions.push(buildRootRequiredManualAction());
        hasAddedRootManualAction = true;
    };
    const pathInstallationPlan = buildPathInstallationCleanupPlan(context);
    if (pathInstallationPlan) {
        for (const action of pathInstallationPlan.actions) {
            if (
                action.kind === 'uninstall-installation'
                && cliHappierRuntime.cliUninstallPlanRequiresRoot({ plan: action.uninstallPlan, uid: processUid })
            ) {
                addRootManualAction();
                continue;
            }
            actions.push({
                command: action.previewCommand,
                reason: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
            });
        }
    }
    const plan = buildBackgroundServiceCleanupPlan(context);
    if (plan) {
        for (const action of plan.actions) {
            if (backgroundServiceCleanupActionRequiresRoot(action, processUid)) {
                addRootManualAction();
                continue;
            }
            if (action.kind === 'remove-service') {
                actions.push({
                    command: `remove background service ${action.service.label}`,
                    reason: action.service.targetMode === 'default-following'
                        ? 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE'
                        : 'LEGACY_PINNED_DAEMON_SERVICE',
                });
                continue;
            }
            const installAction = buildDefaultServiceInstallManualAction(context);
            if (installAction) {
                actions.push(installAction);
            }
        }
    }
    actions.push(...buildManualCleanupActions(context));
    return actions;
}

async function applyDirectCleanupActions(context: SupportMaintenanceContext): Promise<SupportCleanupExecutionResult> {
    const executedActions: string[] = [];
    const manualActions: SupportDelegatedAction[] = [];
    const processUid = resolveProcessUid();
    let hasAddedRootManualAction = false;
    const addRootManualAction = (): void => {
        if (hasAddedRootManualAction) {
            return;
        }
        manualActions.push(buildRootRequiredManualAction());
        hasAddedRootManualAction = true;
    };
    const pathInstallationPlan = buildPathInstallationCleanupPlan(context);
    if (pathInstallationPlan) {
        for (const action of pathInstallationPlan.actions) {
            if (action.kind === 'uninstall-installation') {
                if (cliHappierRuntime.cliUninstallPlanRequiresRoot({
                    plan: action.uninstallPlan,
                    uid: processUid,
                })) {
                    addRootManualAction();
                    continue;
                }
                await cliHappierRuntime.applyCliUninstallPlan({
                    plan: action.uninstallPlan,
                    processEnv: process.env,
                });
                executedActions.push(`uninstall:${action.installation.path}`);
                continue;
            }
            manualActions.push({
                command: action.previewCommand,
                reason: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
            });
        }
    }
    const plan = buildBackgroundServiceCleanupPlan(context);
    if (plan) {
        for (const action of plan.actions) {
            if (backgroundServiceCleanupActionRequiresRoot(action, processUid)) {
                addRootManualAction();
                continue;
            }
            if (action.kind === 'remove-service') {
                await cliHappierRuntime.uninstallHappierService({
                    platform: action.service.platform,
                    backend: action.service.backend,
                    scope: action.service.scope,
                    label: action.service.label,
                    definitionPath: action.service.definitionPath,
                    runCommands: true,
                });
                executedActions.push(`remove:${action.service.label}`);
                continue;
            }
            const installAction = buildDefaultServiceInstallManualAction(context);
            if (installAction) {
                manualActions.push(installAction);
            }
        }
    }
    manualActions.push(...buildManualCleanupActions(context));
    return {
        executedActions,
        manualActions,
    };
}

function renderCleanupPreview(
    actions: readonly SupportDelegatedAction[],
    context: SupportMaintenanceContext,
    presentation?: cliOutput.OutputPresentation,
): string {
    const builder = cliOutput.createOutputBuilder({ presentation });
    builder.line(
        presentation?.banner
            ? presentation.banner('Support cleanup', { subtitle: `${actions.length} action(s)` })
            : `Support cleanup\n${actions.length} action(s)`,
    );
    builder.blank();
    const ownershipSummary = renderSupportCleanupOwnershipSummary(context);
    if (ownershipSummary) {
        builder.section(ownershipSummary.title, (section) => {
            section.bullets(ownershipSummary.lines);
        });
        builder.blank();
    }
    builder.section('Actions', (section) => {
        section.bullets(actions.map((action) => `${action.reason}: ${action.command}`));
    });
    if (actions.length > 0) {
        builder.line(`Re-run with ${renderCmd('--yes')} to apply.`);
    }
    return `${builder.render()}\n`;
}

function renderCleanupApplied(
    result: SupportCleanupExecutionResult,
    context: SupportMaintenanceContext,
    presentation?: cliOutput.OutputPresentation,
): string {
    const builder = cliOutput.createOutputBuilder({ presentation });
    builder.line(
        presentation?.banner
            ? presentation.banner('Support cleanup applied', {
                subtitle: `${result.executedActions.length} action(s)`,
            })
            : `Support cleanup applied\n${result.executedActions.length} action(s)`,
    );
    builder.blank();
    const ownershipSummary = renderSupportCleanupOwnershipSummary(context);
    if (ownershipSummary) {
        builder.section(ownershipSummary.title, (section) => {
            section.bullets(ownershipSummary.lines);
        });
        builder.blank();
    }
    builder.section('Applied', (section) => {
        section.bullets(
            result.executedActions.length > 0
                ? result.executedActions
                : ['No direct cleanup actions were applied.'],
        );
    });
    if (result.manualActions.length > 0) {
        builder.blank();
        builder.section('Manual follow-up', (section) => {
            section.bullets(result.manualActions.map((action) => `${action.reason}: ${action.command}`));
        });
    }
    return `${builder.render()}\n`;
}

export async function runCleanupSupportCommand(
    input: Readonly<{ json: boolean; yes: boolean }>,
    deps: CleanupSupportCommandDeps = {},
): Promise<CleanupSupportCommandResult> {
    const context = await (deps.collectMaintenanceContext ?? collectSupportMaintenanceContext)();
    const actions = buildCleanupPreviewActions(context);
    if (!input.yes) {
        const output = input.json
            ? `${JSON.stringify({ ok: true, executed: false, actions }, null, 2)}\n`
            : renderCleanupPreview(actions, context, deps.presentation);
        return { output, executed: false };
    }

    const result = await applyDirectCleanupActions(context);
    const output = input.json
        ? `${JSON.stringify({
            ok: true,
            executed: true,
            executedActions: result.executedActions,
            actions: result.manualActions,
        }, null, 2)}\n`
        : renderCleanupApplied(result, context, deps.presentation);
    return { output, executed: true };
}
