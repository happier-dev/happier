import { AGENT_IDS, RECOMMENDED_PROVIDER_CLI_IDS_FOR_SETUP, getProviderCliRuntimeSpec, type AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import type { invokeProviderCliInstall as invokeProviderCliInstallDefault } from '@/runtime/managedTools/invokeProviderCliInstall';
import { resolveProviderCliCommand, type ProviderCliCommandResolution } from '@/runtime/managedTools/providerCliResolution';
import { AGENTS } from '@/backends/catalog';
import { bullets, cmd, definitionList, dim, errorFrame, fail, kv, neutral, ok, sectionTitle } from '@happier-dev/cli-common/output';

function usage(): string {
    return [
        `${sectionTitle('happier providers')} - Provider CLI helpers`,
        '',
        `${sectionTitle('Usage:')}`,
        `  ${cmd('happier providers list [--json]')}`,
        `  ${cmd('happier providers status [--json]')}`,
        `  ${cmd('happier providers install <providerId> [--dry-run] [--force]')}`,
        `  ${cmd('happier providers setup [--provider <id> ...] [--providers <id1,id2>] [--dry-run] [--force] [--yes]')}`,
        '',
        `${sectionTitle('Notes:')}`,
        bullets([
            'Providers are the local tools Happier can run sessions with (Codex, Claude, Gemini, OpenCode, ...).',
            'Installs are binary-safe and do not require Node or a package manager.',
            `For cloud-stored API keys and subscription OAuth, use ${cmd('happier connect')}.`,
            `Non-interactive defaults: ${cmd('happier providers setup --yes')} installs the recommended providers.`,
        ]),
        '',
    ].join('\n');
}

function isAgentId(value: string): value is AgentId {
    return (AGENT_IDS as readonly string[]).includes(value);
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
    id: AgentId;
    title: string;
    installed: boolean;
    resolution: ProviderCliCommandResolution | null;
}>;

function listProviderStatus(processEnv: NodeJS.ProcessEnv): ProviderStatusRow[] {
    return (AGENT_IDS as readonly AgentId[])
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map((id) => {
            const spec = getProviderCliRuntimeSpec(id);
            const resolution = resolveProviderCliCommand(id, { processEnv });
            return {
                id,
                title: spec.title,
                installed: resolution !== null,
                resolution,
            };
        });
}

async function invokeProviderCliInstallLazy(
    ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
    const { invokeProviderCliInstall } = await import('@/runtime/managedTools/invokeProviderCliInstall');
    return await invokeProviderCliInstall(...args);
}

function printHumanStatus(rows: readonly ProviderStatusRow[]): void {
    if (rows.length === 0) {
        console.log(neutral('(no providers available)'));
        return;
    }
    for (const row of rows) {
        const source = row.resolution?.source ? ` ${dim(`(${row.resolution.source})`)}` : '';
        console.log((row.installed ? ok : neutral)(`${row.title} ${dim(row.id)}${source}`));
        if (row.resolution?.command) {
            console.log(`  ${kv('Command:', row.resolution.command)}`);
        }
    }
}

async function runProvidersInstall(
    providerId: AgentId,
    flags: Readonly<{ dryRun: boolean; skipIfInstalled: boolean }>,
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
    return await invokeProviderCliInstallLazy({
        agentId: providerId,
        params: flags,
        env: process.env,
        nodePlatform: process.platform,
    });
}

async function resolveProvidersSetupSelection(args: readonly string[]): Promise<AgentId[]> {
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
        const invalid = combined.filter((value) => !isAgentId(value));
        if (invalid.length > 0) {
            throw new Error(`Unknown provider id(s): ${invalid.join(', ')}`);
        }
        return combined as AgentId[];
    }

    if (!isInteractiveTerminal()) {
        if (!args.includes('--yes')) {
            throw new Error('Non-interactive mode: pass one or more --provider <id> flags (or --yes to install the recommended defaults).');
        }
        return [...RECOMMENDED_PROVIDER_CLI_IDS_FOR_SETUP];
    }

    const rows = listProviderStatus(process.env);
    const recommended = rows.filter((row) => !row.installed).map((row) => row.id);
    const hint = recommended.length > 0 ? ` (suggested: ${recommended.join(', ')})` : '';
    const raw = (await promptInput(`Providers to install (comma-separated ids)${hint}: `)).trim();
    if (!raw) return [];
    const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
    const invalid = ids.filter((value) => !isAgentId(value));
    if (invalid.length > 0) {
        throw new Error(`Unknown provider id(s): ${invalid.join(', ')}`);
    }
    return ids as AgentId[];
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

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        console.log(usage());
        return;
    }

    if (subcommand === 'list' || subcommand === 'status') {
        const rows = listProviderStatus(process.env);
        if (json) {
            printJsonEnvelope({
                ok: true,
                kind: subcommand === 'list' ? 'providers_list' : 'providers_status',
                data: {
                    providers: rows.map((row) => ({
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
        printHumanStatus(rows);
        return;
    }

    if (subcommand === 'install') {
        const providerIdRaw = String(args[1] ?? '').trim();
        if (!providerIdRaw || providerIdRaw === 'help' || providerIdRaw === '--help' || providerIdRaw === '-h') {
            console.log(usage());
            return;
        }
        if (!isAgentId(providerIdRaw)) {
            throw new Error(`Unknown provider id: ${providerIdRaw}`);
        }
        const flags = parseInstallFlags(args.slice(2));
        const result = await runProvidersInstall(providerIdRaw, flags);
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

        const runtimeSpec = getProviderCliRuntimeSpec(providerIdRaw);
        if (flags.dryRun) {
            console.log(`Dry run: would install ${runtimeSpec.title} via ${result.plan.installMode}.`);
        } else if (result.alreadyInstalled) {
            console.log(ok(`${runtimeSpec.title} is already installed.`));
        } else {
            console.log(ok(`Installed ${runtimeSpec.title}.`));
        }
        if (result.logPath) console.log(`  ${kv('Install log:', result.logPath)}`);
        return;
    }

    if (subcommand === 'setup') {
        const flags = parseInstallFlags(args.slice(1));
        const providers = await resolveProvidersSetupSelection(args.slice(1));
        if (providers.length === 0) {
            if (json) {
                printJsonEnvelope({ ok: true, kind, data: { providers: [] } });
                return;
            }
            console.log(neutral('(no providers selected)'));
            return;
        }

        const results = [];
        let allOk = true;
        for (const providerId of providers) {
            const result = await runProvidersInstall(providerId, flags);
            results.push({ providerId, result });
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
            if (entry.result.ok) {
                const runtimeSpec = getProviderCliRuntimeSpec(entry.providerId);
                if (flags.dryRun) {
                    console.log(`Dry run: would install ${runtimeSpec.title} via ${entry.result.plan.installMode}.`);
                } else if (entry.result.alreadyInstalled) {
                    console.log(ok(`${runtimeSpec.title} is already installed.`));
                } else {
                    console.log(ok(`Installed ${runtimeSpec.title}.`));
                }
                if (entry.result.logPath) console.log(`  ${kv('Install log:', entry.result.logPath)}`);
            } else {
                console.error(fail(`Failed to install ${entry.providerId}: ${entry.result.errorMessage}`));
                if (entry.result.logPath) console.log(`  ${kv('Install log:', entry.result.logPath)}`);
            }
        }

        if (!json && !flags.dryRun) {
            const connectable = providers.filter((id) => {
                const entry = (AGENTS as Partial<Record<string, unknown>>)[id];
                const getCloudConnectTarget = entry && typeof entry === 'object' && !Array.isArray(entry)
                    ? (entry as { getCloudConnectTarget?: unknown }).getCloudConnectTarget
                    : undefined;
                return typeof getCloudConnectTarget === 'function';
            });
            if (connectable.length > 0) {
                console.log('');
                console.log(sectionTitle('Next'));
                console.log(bullets(connectable.map((id) => `Connect ${id} credentials in Happier Cloud: ${cmd(`happier connect ${id}`)}`)));
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
