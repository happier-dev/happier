import { basename } from 'node:path';

import type { CommandContext } from '@/cli/commandRegistry';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import {
    applyCliUninstallPlan,
    buildCliUninstallPlan,
    cliUninstallPlanRequiresRoot,
    discoverHappierInstallations,
    discoverHappierServices,
    parseUnsupportedInstallSourceFromInstallationId,
} from '@happier-dev/cli-common/happierRuntime';
import { cmd, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

type UninstallFlags = Readonly<{
    json: boolean;
    yes: boolean;
    dryRun: boolean;
    keepService: boolean;
    help: boolean;
}>;

function usage(): string {
    return [
        `${sectionTitle('happier uninstall')} - Uninstall the current managed Happier CLI`,
        '',
        sectionTitle('Usage:'),
        `  ${cmd('happier uninstall [--yes] [--dry-run] [--keep-service] [--json]')}`,
        '',
    ].join('\n');
}

function parseFlags(args: readonly string[]): UninstallFlags {
    const flags = new Set(args.filter((arg) => arg.startsWith('-')));
    return {
        json: flags.has('--json'),
        yes: flags.has('--yes') || flags.has('-y'),
        dryRun: flags.has('--dry-run'),
        keepService: flags.has('--keep-service'),
        help: flags.has('--help') || flags.has('-h'),
    };
}

function resolveInvokerName(): string | null {
    const envInvokerName = basename(String(process.env.HAPPIER_CLI_INVOKER_NAME ?? '').trim())
        .replace(/\.exe$/iu, '')
        .replace(/\.m?js$/iu, '')
        .trim();
    if (envInvokerName) return envInvokerName;
    const candidates = [process.argv[1] ?? '', process.argv[0] ?? ''];
    for (const candidate of candidates) {
        const normalized = basename(String(candidate ?? '').trim())
            .replace(/\.exe$/iu, '')
            .replace(/\.m?js$/iu, '')
            .trim();
        if (normalized) return normalized;
    }
    return null;
}

async function printJson(data: unknown): Promise<void> {
    await writeJsonStdout(data);
}

function resolveProcessUid(): number | null {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

export async function handleUninstallCliCommand(context: CommandContext): Promise<void> {
    const flags = parseFlags(context.args.slice(1));
    if (flags.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }

    const envInvokedPath = String(process.env.HAPPIER_CLI_INVOKED_PATH ?? '').trim();
    const invokedPath = envInvokedPath || process.argv[1] || null;
    const installations = await discoverHappierInstallations({
        processEnv: process.env,
        invokedPath,
        invokerName: resolveInvokerName(),
    });
    const servicesInventory = await discoverHappierServices({ processEnv: process.env });
    const selectedInstallation = installations.installations.find(
        (entry) => entry.id === installations.activeInvocation?.installationId,
    ) ?? null;
    const plan = buildCliUninstallPlan({
        selectedInstallation,
        inferredUnsupportedSource: parseUnsupportedInstallSourceFromInstallationId(
            installations.activeInvocation?.installationId ?? null,
        ),
        services: servicesInventory.services,
        keepService: flags.keepService,
    });

    if (plan.kind === 'unsupported-install-source') {
        if (flags.json) {
            await printJson({
                ok: false,
                error: 'unsupported_install_source',
                source: plan.source,
                manualCommands: plan.manualCommands,
            });
            return;
        }
        throw new Error(`Automatic uninstall is only supported for managed Happier CLI installs. Try: ${plan.manualCommands[0]}`);
    }

    if (plan.kind === 'active-installation-not-found') {
        if (flags.json) {
            await printJson({ ok: false, error: 'active_installation_not_found' });
            return;
        }
        throw new Error('Could not determine the active Happier installation to uninstall.');
    }

    const previewOnly = flags.dryRun || !flags.yes;
    if (previewOnly) {
        if (flags.json) {
            await printJson(plan.kind === 'npm-global-installation'
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
                        ring: service.ring,
                        instanceId: service.instanceId,
                    })),
                });
            return;
        }
        process.stdout.write(`${usage()}\n`);
        process.stdout.write(`${warn(`Would uninstall ${plan.installation.path}`)}\n`);
        for (const service of plan.serviceTargets) {
            process.stdout.write(`${warn(`Would uninstall service ${service.label}`)}\n`);
        }
        if (!flags.dryRun) {
            process.stdout.write(`Re-run with ${cmd('--yes')} to apply.\n`);
        }
        return;
    }

    if (cliUninstallPlanRequiresRoot({ plan, uid: resolveProcessUid() })) {
        const invokerName = installations.activeInvocation?.invokerName?.trim() || resolveInvokerName() || 'happier';
        const manualCommand = `sudo ${invokerName} uninstall --yes`;
        if (flags.json) {
            await printJson({
                ok: false,
                error: 'root_privileges_required',
                manualCommands: [manualCommand],
            });
            return;
        }
        throw new Error(`Root privileges are required to uninstall system-scoped Happier services. Try: ${manualCommand}`);
    }

    const result = await applyCliUninstallPlan({
        plan,
        processEnv: process.env,
    });

    if (flags.json) {
        await printJson({
            ok: true,
            executed: true,
            removedPaths: result.removedPaths,
            ...(plan.kind === 'npm-global-installation'
                ? { actions: result.actions ?? [] }
                : {
                    serviceTargets: plan.serviceTargets.map((service) => ({
                        id: service.id,
                        label: service.label,
                    })),
                }),
        });
        return;
    }

    process.stdout.write(`${ok('Happier CLI uninstalled.')}\n`);
}
