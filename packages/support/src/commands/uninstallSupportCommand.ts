import * as cliHappierRuntime from '@happier-dev/cli-common/happierRuntime';

import { collectSupportMaintenanceContext, type SupportMaintenanceContext } from '../runtime/collectSupportMaintenanceContext.js';

export type UninstallSupportCommandResult = Readonly<{
    output: string;
    executed: boolean;
}>;

export type UninstallSupportCommandDeps = Readonly<{
    collectMaintenanceContext?: () => Promise<SupportMaintenanceContext> | SupportMaintenanceContext;
}>;

function printJson(data: unknown): string {
    return `${JSON.stringify(data, null, 2)}\n`;
}

function resolveProcessUid(): number | null {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function resolveSelectedInstallation(
    context: SupportMaintenanceContext,
): cliHappierRuntime.HappierInstallation | null {
    if (context.selectedInstallation) {
        return context.selectedInstallation;
    }
    const activeInstallationId = context.installations?.activeInvocation?.installationId ?? null;
    if (!activeInstallationId) {
        return null;
    }
    return context.installations?.installations.find((entry) => entry.id === activeInstallationId) ?? null;
}

export async function runUninstallSupportCommand(
    input: Readonly<{ json: boolean; yes: boolean; dryRun: boolean; keepService: boolean }>,
    deps: UninstallSupportCommandDeps = {},
): Promise<UninstallSupportCommandResult> {
    const context = await (deps.collectMaintenanceContext ?? collectSupportMaintenanceContext)();
    const plan = cliHappierRuntime.buildCliUninstallPlan({
        selectedInstallation: resolveSelectedInstallation(context),
        inferredUnsupportedSource: cliHappierRuntime.parseUnsupportedInstallSourceFromInstallationId(
            context.installations?.activeInvocation?.installationId ?? null,
        ),
        services: context.services ?? [],
        keepService: input.keepService,
    });

    if (plan.kind === 'unsupported-install-source') {
        return {
            output: printJson({
                ok: false,
                error: 'unsupported_install_source',
                source: plan.source,
                manualCommands: plan.manualCommands,
            }),
            executed: false,
        };
    }

    if (plan.kind === 'active-installation-not-found') {
        return {
            output: printJson({ ok: false, error: 'active_installation_not_found' }),
            executed: false,
        };
    }

    if (!input.yes || input.dryRun) {
        return {
            output: printJson(plan.kind === 'npm-global-installation'
                ? {
                    ok: true,
                    executed: false,
                    installation: {
                        id: plan.installation.id,
                        source: plan.installation.source,
                        ring: plan.installation.ring,
                        path: plan.installation.path,
                    },
                    actions: [{
                        command: [plan.command.cmd, ...plan.command.args].join(' '),
                        reason: 'npm-global-installation',
                    }],
                }
                : {
                    ok: true,
                    executed: false,
                    installation: {
                        id: plan.installation.id,
                        source: plan.installation.source,
                        ring: plan.installation.ring,
                        path: plan.installation.path,
                    },
                    serviceTargets: plan.serviceTargets.map((service) => ({
                        id: service.id,
                        label: service.label,
                    })),
                }),
            executed: false,
        };
    }

    if (cliHappierRuntime.cliUninstallPlanRequiresRoot({ plan, uid: resolveProcessUid() })) {
        return {
            output: printJson({
                ok: false,
                error: 'root_privileges_required',
                manualCommands: ['sudo npx @happier-dev/support uninstall --yes'],
            }),
            executed: false,
        };
    }

    const result = await cliHappierRuntime.applyCliUninstallPlan({
        plan,
        processEnv: process.env,
    });
    return {
        output: printJson({
            ok: true,
            executed: true,
            removedPaths: result.removedPaths,
            ...(plan.kind === 'npm-global-installation'
                ? { actions: result.actions ?? [] }
                : { serviceTargets: result.serviceTargets }),
        }),
        executed: true,
    };
}
