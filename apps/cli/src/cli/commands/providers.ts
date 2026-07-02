import {
    getAgentCliSetupRecommendedIds,
} from '@happier-dev/agents';
import {
    installProviderCliForRuntime,
    resolvePlatformFromNodePlatform,
    resolveProviderCliCommandForRuntime,
    type InstallProviderCliResult,
    type ProviderCliCommandResolution,
    type ProviderCliRuntimeDescriptor,
} from '@happier-dev/cli-common/providers';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry, ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { bullets, cmd, createOutputBuilder, dim, errorFrame, fail, kv, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import { resolveConnectTargetServiceIdsFromRegistry } from './connect/resolveConnectTargetServiceIds';

function usage(providerRows: readonly ProviderStatusRow[] = []): string {
    const providerRowsSection = providerRows.length > 0
      ? [{
          title: 'Available providers:',
          rows: providerRows.map((row) => ({
            label: cmd(`${row.title} (${row.id})`),
            description: `Install with ${cmd(`happier providers install ${row.id}`)}`,
          })),
        }]
      : [];

    return renderHelpPage({
        title: 'happier providers',
        subtitle: 'Provider CLI helpers',
        usage: [
            { label: 'happier providers list [--json]', description: 'List providers and whether they are installed' },
            { label: 'happier providers status [--json]', description: 'Show provider status for the current environment' },
            { label: 'happier providers install <providerId> [--dry-run] [--force]', description: 'Install one provider CLI' },
            { label: 'happier providers setup [--provider <id> ...] [--providers <id1,id2>] [--dry-run] [--force] [--yes]', description: 'Install one or more providers' },
        ],
        sections: providerRowsSection,
        notes: [
            'Providers are the local tools Happier can run sessions with.',
            'Installs are binary-safe and do not require Node or a package manager.',
            `For cloud-stored API keys and subscription OAuth, use ${cmd('happier connect')}.`,
            `Non-interactive defaults: ${cmd('happier providers setup --yes')} installs the recommended providers.`,
        ],
    });
}

function readRepeatedFlagValues(argv: readonly string[], flag: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== flag) continue;
        const value = argv[index + 1];
        if (typeof value === 'string' && value.trim()) {
            values.push(value.trim());
            index += 1;
        }
    }
    return values;
}

function readSingleFlagValue(argv: readonly string[], flag: string): string | null {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function parseInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
    return {
        dryRun: args.includes('--dry-run'),
        skipIfInstalled: !args.includes('--force'),
    };
}

type ProviderStatusRow = Readonly<{
    id: string;
    title: string;
    runtimeSpec: ProviderCliRuntimeDescriptor;
    installed: boolean;
    resolution: ProviderCliCommandResolution | null;
}>;

function readAgentCliRuntimeDescriptor(contribution: ResolvedProviderContribution): ProviderCliRuntimeDescriptor | null {
    return contribution.runtimeSpec ?? null;
}

function listProviderStatus(
    registry: Pick<ResolvedContributionRegistry, 'providers'>,
    processEnv: NodeJS.ProcessEnv,
): ProviderStatusRow[] {
    return registry.providers
        .map((contribution) => {
            const runtimeSpec = readAgentCliRuntimeDescriptor(contribution);
            if (!runtimeSpec) return null;
            const resolution = resolveProviderCliCommandForRuntime(runtimeSpec, { processEnv });
            return {
                id: contribution.id,
                title: runtimeSpec.title,
                runtimeSpec,
                installed: resolution !== null,
                resolution,
            } satisfies ProviderStatusRow;
        })
        .filter((row): row is ProviderStatusRow => row !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
}

function printHumanStatus(rows: readonly ProviderStatusRow[]): void {
    const out = createOutputBuilder();
    if (rows.length === 0) {
        out.line(neutral('(no providers available)'));
        console.log(out.render());
        return;
    }

    for (const row of rows) {
        const source = row.resolution?.source ? ` ${dim(`(${row.resolution.source})`)}` : '';
        out.line((row.installed ? ok : neutral)(`${row.title} ${dim(row.id)}${source}`));
        if (row.resolution?.command) {
            out.line(`  ${kv('Command:', row.resolution.command)}`);
        }
    }
    console.log(out.render());
}

async function runProvidersInstall(
    runtimeSpec: ProviderCliRuntimeDescriptor,
    flags: Readonly<{ dryRun: boolean; skipIfInstalled: boolean }>,
): Promise<InstallProviderCliResult> {
    const platform = resolvePlatformFromNodePlatform(process.platform);
    if (!platform) {
        return {
            ok: false,
            errorCode: 'no-recipe',
            errorMessage: `Unsupported platform: ${process.platform}`,
            plan: null,
            logPath: null,
        };
    }
    return await installProviderCliForRuntime({
        runtimeSpec,
        platform,
        env: process.env,
        dryRun: flags.dryRun,
        skipIfInstalled: flags.skipIfInstalled,
        allowVendorRecipeExecution: !flags.dryRun,
    });
}

function isSetupSupportedProviderRow(row: ProviderStatusRow): boolean {
    return row.runtimeSpec.manualInstallKind !== 'none';
}

async function resolveProvidersSetupSelection(args: readonly string[], rows: readonly ProviderStatusRow[]): Promise<string[]> {
    const supportedRows = rows.filter(isSetupSupportedProviderRow);
    const supportedById = new Map(supportedRows.map((row) => [row.id, row] as const));
    const explicit = readRepeatedFlagValues(args, '--provider');
    const csv = (() => {
        const raw = readSingleFlagValue(args, '--providers');
        if (!raw) return [];
        return raw
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    })();
    const combined = [...explicit, ...csv];
    if (combined.length > 0) {
        const invalid = combined.filter((value) => !supportedById.has(value));
        if (invalid.length > 0) {
            throw new Error(`Unsupported provider id(s) for setup: ${invalid.join(', ')}`);
        }
        return combined;
    }

    if (!isInteractiveTerminal()) {
        if (!args.includes('--yes')) {
            throw new Error('Non-interactive mode: pass one or more --provider <id> flags (or --yes to install the recommended defaults).');
        }
        return getAgentCliSetupRecommendedIds().filter((id) => supportedById.has(id));
    }

    const recommended = getAgentCliSetupRecommendedIds().filter(
        (id) => supportedById.has(id) && !supportedById.get(id)?.installed,
    );
    const hint = recommended.length > 0 ? ` (suggested: ${recommended.join(', ')})` : '';
    const raw = (await promptInput(`Providers to install (comma-separated ids)${hint}: `)).trim();
    if (!raw) return [];
    const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
    const invalid = ids.filter((value) => !supportedById.has(value));
    if (invalid.length > 0) {
        throw new Error(`Unsupported provider id(s) for setup: ${invalid.join(', ')}`);
    }
    return ids;
}

export async function handleProvidersCommand(args: string[]): Promise<void> {
    const json = wantsJson(args);
    const subcommand = String(args[0] ?? '').trim();
    const kind = (() => {
        if (!subcommand) return 'providers_unknown';
        if (subcommand === 'list') return 'providers_list';
        if (subcommand === 'status') return 'providers_status';
        if (subcommand === 'install') return 'providers_install';
        if (subcommand === 'setup') return 'providers_setup';
        return `providers_${subcommand}`;
    })();

    const needsProviderRegistry =
        subcommand === 'list'
        || subcommand === 'status'
        || subcommand === 'install'
        || subcommand === 'setup'
        || !subcommand
        || subcommand === 'help'
        || subcommand === '--help'
        || subcommand === '-h';
    const mergedRegistry = needsProviderRegistry
        ? await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
        : null;
    const providerRows = needsProviderRegistry
        ? listProviderStatus(mergedRegistry!, process.env)
        : [];
    const providerRowsById = new Map(providerRows.map((row) => [row.id, row] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        console.log(usage(providerRows));
        return;
    }

    if (subcommand === 'list' || subcommand === 'status') {
        if (json) {
            printJsonEnvelope({
                ok: true,
                kind: subcommand === 'list' ? 'providers_list' : 'providers_status',
                data: {
                    providers: providerRows.map((row) => ({
                        id: row.id,
                        title: row.title,
                        installed: row.installed,
                        source: row.resolution?.source ?? null,
                        command: row.resolution?.command ?? null,
                    })),
                },
            });
            return;
        }
        printHumanStatus(providerRows);
        return;
    }

    if (subcommand === 'install') {
        const providerIdRaw = String(args[1] ?? '').trim();
        if (!providerIdRaw || providerIdRaw === 'help' || providerIdRaw === '--help' || providerIdRaw === '-h') {
            console.log(usage());
            return;
        }
        const providerRow = providerRowsById.get(providerIdRaw);
        if (!providerRow) {
            throw new Error(`Unknown provider id: ${providerIdRaw}`);
        }
        const flags = parseInstallFlags(args.slice(2));
        const result = await runProvidersInstall(providerRow.runtimeSpec, flags);
        if (json) {
            if (result.ok) {
                printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            providerId: providerIdRaw,
                            alreadyInstalled: result.alreadyInstalled ?? false,
                            plan: result.plan,
                            logPath: result.logPath ?? null,
                        },
                    },
                    { exitCode: 0 },
                );
                return;
            }
            printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: 'install_failed',
                        message: result.errorMessage,
                        logPath: result.logPath ?? null,
                    },
                },
                { exitCode: 1 },
            );
            return;
        }

        if (!result.ok) {
            console.error(errorFrame('Error:', [result.errorMessage, ...(result.logPath ? [`Install log: ${result.logPath}`] : [])]));
            process.exitCode = 1;
            return;
        }

        const out = createOutputBuilder();
        if (flags.dryRun) {
            out.line(`Dry run: would install ${providerRow.title} via ${result.plan.installMode}.`);
        } else if (result.alreadyInstalled) {
            out.line(ok(`${providerRow.title} is already installed.`));
        } else {
            out.line(ok(`Installed ${providerRow.title}.`));
        }
        if (result.logPath) out.line(`  ${kv('Install log:', result.logPath)}`);
        console.log(out.render());
        return;
    }

    if (subcommand === 'setup') {
        const flags = parseInstallFlags(args.slice(1));
        const providerIds = await resolveProvidersSetupSelection(args.slice(1), providerRows);
        if (providerIds.length === 0) {
            if (json) {
                printJsonEnvelope({ ok: true, kind, data: { providers: [] } });
                return;
            }
            console.log(neutral('(no providers selected)'));
            return;
        }

        const results = [];
        let allOk = true;
        for (const providerId of providerIds) {
            const providerRow = providerRowsById.get(providerId);
            if (!providerRow) {
                throw new Error(`Unknown provider id: ${providerId}`);
            }
            const result = await runProvidersInstall(providerRow.runtimeSpec, flags);
            results.push({ providerId, title: providerRow.title, result });
            if (!result.ok) allOk = false;
        }

        if (json) {
            if (allOk) {
                printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            providers: results.map((entry) => ({
                                providerId: entry.providerId,
                                ok: true,
                                alreadyInstalled: entry.result.ok ? entry.result.alreadyInstalled ?? false : null,
                                plan: entry.result.ok ? entry.result.plan : null,
                                logPath: entry.result.logPath ?? null,
                                errorMessage: null,
                            })),
                        },
                    },
                    { exitCode: 0 },
                );
                return;
            }
            printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: 'install_failed',
                        providers: results.map((entry) => ({
                            providerId: entry.providerId,
                            ok: entry.result.ok,
                            alreadyInstalled: entry.result.ok ? entry.result.alreadyInstalled ?? false : null,
                            plan: entry.result.ok ? entry.result.plan : null,
                            logPath: entry.result.logPath ?? null,
                            errorMessage: entry.result.ok ? null : entry.result.errorMessage,
                        })),
                    },
                },
                { exitCode: 1 },
            );
            return;
        }

        for (const entry of results) {
            const out = createOutputBuilder();
            if (entry.result.ok) {
                if (flags.dryRun) {
                    out.line(`Dry run: would install ${entry.title} via ${entry.result.plan.installMode}.`);
                } else if (entry.result.alreadyInstalled) {
                    out.line(ok(`${entry.title} is already installed.`));
                } else {
                    out.line(ok(`Installed ${entry.title}.`));
                }
                if (entry.result.logPath) out.line(`  ${kv('Install log:', entry.result.logPath)}`);
                console.log(out.render());
            } else {
                console.error(fail(`Failed to install ${entry.providerId}: ${entry.result.errorMessage}`));
                if (entry.result.logPath) {
                    console.log(`  ${kv('Install log:', entry.result.logPath)}`);
                }
            }
        }

        if (!json && !flags.dryRun) {
            const connectable = providerIds.filter((id) => (
                mergedRegistry
                    ? resolveConnectTargetServiceIdsFromRegistry(id, mergedRegistry).length > 0
                    : false
            ));
            if (connectable.length > 0) {
                const out = createOutputBuilder();
                out.blank();
                out.line(sectionTitle('Next'));
                out.line(bullets(connectable.map((id) => `Connect ${id} credentials in Happier Cloud: ${cmd(`happier connect ${id}`)}`)));
                console.log(out.render());
            }
        }

        if (!allOk) {
            process.exitCode = 1;
        }
        return;
    }

    if (json) {
        printJsonEnvelope({ ok: false, kind, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
        return;
    }

    console.error(errorFrame('Error:', [`Unknown providers subcommand: ${subcommand}`]));
    console.log(usage());
    process.exitCode = 1;
}

export async function handleProvidersCliCommand(context: CommandContext): Promise<void> {
    try {
        await handleProvidersCommand(context.args.slice(1));
    } catch (error) {
        const args = context.args.slice(1);
        if (wantsJson(args)) {
            const subcommand = String(args[0] ?? '').trim();
            const kind = subcommand ? `providers_${subcommand}` : 'providers_unknown';
            printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: 'operation_failed',
                        message: error instanceof Error ? error.message : 'Unknown error',
                    },
                },
                { exitCode: 1 },
            );
            return;
        }
        console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
        if (process.env.DEBUG) console.error(error);
        console.log(usage());
        process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
    }
}
