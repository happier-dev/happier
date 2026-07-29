import {
    getAgentCliSetupRecommendedIds,
} from '@happier-dev/agents';
import {
    installAgentCliForRuntime,
    resolvePlatformFromNodePlatform,
    resolveAgentCliCommandForRuntime,
    type InstallAgentCliResult,
    type AgentCliCommandResolution,
    type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry, ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { bullets, cmd, createOutputBuilder, dim, errorFrame, fail, kv, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import type { CapabilityId } from '@happier-dev/protocol';
import { resolveConnectTargetServiceIdsFromRegistry } from './connect/resolveConnectTargetServiceIds';

function usage(agentRows: readonly AgentStatusRow[] = []): string {
    const agentRowsSection = agentRows.length > 0
      ? [{
          title: 'Available agents:',
          rows: agentRows.map((row) => ({
            label: cmd(`${row.title} (${row.id})`),
            description: row.runtimeSpec
                ? `Install with ${cmd(`happier agents install ${row.id}`)}`
                : 'Provided by an installed plugin runtime',
          })),
        }]
      : [];

    return renderHelpPage({
        title: 'happier agents',
        subtitle: 'Agent CLI helpers',
        usage: [
            { label: 'happier agents list [--json]', description: 'List agents and whether they are installed' },
            { label: 'happier agents status [--json]', description: 'Show agent status for the current environment' },
            { label: 'happier agents probe <agentId> [--models] [--modes] [--config-options] [--json]', description: 'Probe agent model, mode, and config-option availability' },
            { label: 'happier agents install <agentId> [--dry-run] [--force]', description: 'Install one agent CLI' },
            { label: 'happier agents setup [--provider <id> ...] [--providers <id1,id2>] [--dry-run] [--force] [--yes]', description: 'Install one or more agents' },
        ],
        sections: agentRowsSection,
        notes: [
            'Agents are the local tools Happier can run sessions with.',
            'Installs are binary-safe and do not require Node or a package manager.',
            `For cloud-stored API keys and subscription OAuth, use ${cmd('happier connect')}.`,
            `Non-interactive defaults: ${cmd('happier agents setup --yes')} installs the recommended agents.`,
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

class UnsupportedAgentsSetupSelectionError extends Error {
    readonly code = 'unsupported_agent';
    readonly agentIds: readonly string[];

    constructor(agentIds: readonly string[]) {
        super(`Unsupported agent id(s) for setup: ${agentIds.join(', ')}`);
        this.name = 'UnsupportedAgentsSetupSelectionError';
        this.agentIds = agentIds;
    }
}

type AgentProbeMethod = 'probeModels' | 'probeModes' | 'probeConfigOptions';

function parseAgentProbeMethods(args: readonly string[]): AgentProbeMethod[] {
    const includeModels = args.includes('--models');
    const includeModes = args.includes('--modes');
    const includeConfigOptions = args.includes('--config-options') || args.includes('--config');
    if (!includeModels && !includeModes && !includeConfigOptions) {
        return ['probeModels', 'probeModes', 'probeConfigOptions'];
    }
    return [
        ...(includeModels ? ['probeModels' as const] : []),
        ...(includeModes ? ['probeModes' as const] : []),
        ...(includeConfigOptions ? ['probeConfigOptions' as const] : []),
    ];
}

function parsePositiveIntFlag(args: readonly string[], flag: string): number | null {
    const raw = readSingleFlagValue(args, flag);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function agentProbeResultKey(method: AgentProbeMethod): 'models' | 'modes' | 'configOptions' {
    if (method === 'probeModels') return 'models';
    if (method === 'probeModes') return 'modes';
    return 'configOptions';
}

function printUnknownAgentJsonEnvelope(kind: string, agentId: string): void {
    printJsonEnvelope({
        ok: false,
        kind,
        error: {
            code: 'unknown_agent',
            message: `Unknown agent id: ${agentId}`,
            agentId,
        },
    }, { exitCode: 1 });
}

type AgentStatusRow = Readonly<{
    id: string;
    title: string;
    runtimeSpec: AgentCliRuntimeDescriptor | null;
    installed: boolean;
    resolution: AgentCliCommandResolution | null;
}>;

type InstallableAgentStatusRow = AgentStatusRow & Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
}>;

function readAgentCliRuntimeDescriptor(contribution: ResolvedAgentContribution): AgentCliRuntimeDescriptor | null {
    return contribution.runtimeSpec ?? null;
}

function readAgentTitle(contribution: ResolvedAgentContribution): string {
    const runtimeTitle = contribution.runtimeSpec?.title;
    if (runtimeTitle) return runtimeTitle;
    const definition = contribution.richDefinition?.definition as Readonly<{ title?: unknown }> | undefined;
    const title = definition?.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
    if (title && typeof title === 'object' && 'fallback' in title) {
        const fallback = (title as Readonly<{ fallback?: unknown }>).fallback;
        if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    }
    return contribution.id;
}

function listAgentStatus(
    registry: Pick<ResolvedContributionRegistry, 'agents'>,
    processEnv: NodeJS.ProcessEnv,
): AgentStatusRow[] {
    return registry.agents
        .map((contribution) => {
            const runtimeSpec = readAgentCliRuntimeDescriptor(contribution);
            const resolution = runtimeSpec
                ? resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv })
                : null;
            return {
                id: contribution.id,
                title: readAgentTitle(contribution),
                runtimeSpec,
                installed: resolution !== null,
                resolution,
            } satisfies AgentStatusRow;
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}

function printHumanStatus(rows: readonly AgentStatusRow[]): void {
    const out = createOutputBuilder();
    if (rows.length === 0) {
        out.line(neutral('(no agents available)'));
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

async function runAgentsInstall(
    runtimeSpec: AgentCliRuntimeDescriptor,
    flags: Readonly<{ dryRun: boolean; skipIfInstalled: boolean }>,
): Promise<InstallAgentCliResult> {
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
    return await installAgentCliForRuntime({
        runtimeSpec,
        platform,
        env: process.env,
        dryRun: flags.dryRun,
        skipIfInstalled: flags.skipIfInstalled,
        allowVendorRecipeExecution: !flags.dryRun,
    });
}

function isSetupSupportedAgentRow(row: AgentStatusRow): row is InstallableAgentStatusRow {
    return row.runtimeSpec !== null && row.runtimeSpec.manualInstallKind !== 'none';
}

async function resolveAgentsSetupSelection(args: readonly string[], rows: readonly AgentStatusRow[]): Promise<string[]> {
    const supportedRows = rows.filter(isSetupSupportedAgentRow);
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
            throw new UnsupportedAgentsSetupSelectionError(invalid);
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
    const raw = (await promptInput(`Agents to install (comma-separated ids)${hint}: `)).trim();
    if (!raw) return [];
    const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
    const invalid = ids.filter((value) => !supportedById.has(value));
    if (invalid.length > 0) {
        throw new UnsupportedAgentsSetupSelectionError(invalid);
    }
    return ids;
}

export async function handleAgentsCommand(args: string[]): Promise<void> {
    const json = wantsJson(args);
    const subcommand = String(args[0] ?? '').trim();
    const kind = (() => {
        if (!subcommand) return 'agents_unknown';
        if (subcommand === 'list') return 'agents_list';
        if (subcommand === 'status') return 'agents_status';
        if (subcommand === 'probe') return 'agents_probe';
        if (subcommand === 'install') return 'agents_install';
        if (subcommand === 'setup') return 'agents_setup';
        return `agents_${subcommand}`;
    })();

    const needsAgentRegistry =
        subcommand === 'list'
        || subcommand === 'status'
        || subcommand === 'probe'
        || subcommand === 'install'
        || subcommand === 'setup'
        || !subcommand
        || subcommand === 'help'
        || subcommand === '--help'
        || subcommand === '-h';
    const mergedRegistry = needsAgentRegistry
        ? await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
        : null;
    const agentRows = needsAgentRegistry
        ? listAgentStatus(mergedRegistry!, process.env)
        : [];
    const agentRowsById = new Map(agentRows.map((row) => [row.id, row] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        console.log(usage(agentRows));
        return;
    }

    if (subcommand === 'list' || subcommand === 'status') {
        if (json) {
            printJsonEnvelope({
                ok: true,
                kind: subcommand === 'list' ? 'agents_list' : 'agents_status',
                data: {
                    agents: agentRows.map((row) => ({
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
        printHumanStatus(agentRows);
        return;
    }

    if (subcommand === 'probe') {
        const agentId = String(args[1] ?? '').trim();
        if (!agentId || agentId === 'help' || agentId === '--help' || agentId === '-h') {
            console.log(usage(agentRows));
            return;
        }
        const agentRow = agentRowsById.get(agentId);
        if (!agentRow) {
            if (json) {
                printUnknownAgentJsonEnvelope(kind, agentId);
                return;
            }
            throw new Error(`Unknown agent id: ${agentId}`);
        }

        const probeArgs = args.slice(2);
        const methods = parseAgentProbeMethods(probeArgs);
        const timeoutMs = parsePositiveIntFlag(probeArgs, '--timeout-ms') ?? parsePositiveIntFlag(probeArgs, '--timeout');
        const cwd = readSingleFlagValue(probeArgs, '--cwd') ?? readSingleFlagValue(probeArgs, '--path') ?? process.cwd();
        const { createCliCapabilitiesService } = await import('@/rpc/handlers/capabilities');
        const service = await createCliCapabilitiesService();
        const capabilityId = `cli.${agentId}` as CapabilityId;
        const probes: Record<string, unknown> = {};

        for (const method of methods) {
            const result = await service.invoke({
                id: capabilityId,
                method,
                params: {
                    cwd,
                    ...(timeoutMs ? { timeoutMs } : {}),
                },
            });
            if (!result.ok) {
                const code = typeof result.error?.code === 'string' ? result.error.code : 'probe_failed';
                const message = typeof result.error?.message === 'string' ? result.error.message : `Agent probe failed: ${method}`;
                if (json) {
                    printJsonEnvelope({
                        ok: false,
                        kind,
                        error: { code, message, agentId, method },
                    }, { exitCode: 1 });
                    return;
                }
                throw new Error(message);
            }
            probes[agentProbeResultKey(method)] = result.result;
        }

        if (json) {
            printJsonEnvelope({
                ok: true,
                kind,
                data: {
                    agentId,
                    title: agentRow.title,
                    probes,
                },
            });
            return;
        }

        const out = createOutputBuilder();
        out.line(ok(`${agentRow.title} ${dim(agentId)}`));
        for (const [key, value] of Object.entries(probes)) {
            const source = typeof (value as { source?: unknown })?.source === 'string'
                ? ` ${dim(`(${(value as { source: string }).source})`)}`
                : '';
            out.line(`  ${kv(`${key}:`, source ? source.trim() : 'ok')}`);
        }
        console.log(out.render());
        return;
    }

    if (subcommand === 'install') {
        const agentIdRaw = String(args[1] ?? '').trim();
        if (!agentIdRaw || agentIdRaw === 'help' || agentIdRaw === '--help' || agentIdRaw === '-h') {
            console.log(usage());
            return;
        }
        const agentRow = agentRowsById.get(agentIdRaw);
        if (!agentRow) {
            if (json) {
                printUnknownAgentJsonEnvelope(kind, agentIdRaw);
                return;
            }
            throw new Error(`Unknown agent id: ${agentIdRaw}`);
        }
        if (!agentRow.runtimeSpec) {
            const message = `Agent '${agentIdRaw}' does not publish a CLI installation recipe.`;
            if (json) {
                printJsonEnvelope({
                    ok: false,
                    kind,
                    error: { code: 'agent_install_unsupported', message, agentId: agentIdRaw },
                }, { exitCode: 1 });
                return;
            }
            throw new Error(message);
        }
        const flags = parseInstallFlags(args.slice(2));
        const result = await runAgentsInstall(agentRow.runtimeSpec, flags);
        if (json) {
            if (result.ok) {
                printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            agentId: agentIdRaw,
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
            out.line(`Dry run: would install ${agentRow.title} via ${result.plan.installMode}.`);
        } else if (result.alreadyInstalled) {
            out.line(ok(`${agentRow.title} is already installed.`));
        } else {
            out.line(ok(`Installed ${agentRow.title}.`));
        }
        if (result.logPath) out.line(`  ${kv('Install log:', result.logPath)}`);
        console.log(out.render());
        return;
    }

    if (subcommand === 'setup') {
        const flags = parseInstallFlags(args.slice(1));
        let agentIds: string[];
        try {
            agentIds = await resolveAgentsSetupSelection(args.slice(1), agentRows);
        } catch (error) {
            if (json && error instanceof UnsupportedAgentsSetupSelectionError) {
                printJsonEnvelope({
                    ok: false,
                    kind,
                    error: {
                        code: error.code,
                        message: error.message,
                        agentIds: error.agentIds,
                    },
                }, { exitCode: 1 });
                return;
            }
            throw error;
        }
        if (agentIds.length === 0) {
            if (json) {
                printJsonEnvelope({ ok: true, kind, data: { agents: [] } });
                return;
            }
            console.log(neutral('(no agents selected)'));
            return;
        }

        const results = [];
        let allOk = true;
        for (const agentId of agentIds) {
            const agentRow = agentRowsById.get(agentId);
            if (!agentRow?.runtimeSpec) {
                throw new Error(`Agent '${agentId}' does not publish a CLI installation recipe.`);
            }
            const result = await runAgentsInstall(agentRow.runtimeSpec, flags);
            results.push({ agentId, title: agentRow.title, result });
            if (!result.ok) allOk = false;
        }

        if (json) {
            if (allOk) {
                printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            agents: results.map((entry) => ({
                                agentId: entry.agentId,
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
                        agents: results.map((entry) => ({
                            agentId: entry.agentId,
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
                console.error(fail(`Failed to install ${entry.agentId}: ${entry.result.errorMessage}`));
                if (entry.result.logPath) {
                    console.log(`  ${kv('Install log:', entry.result.logPath)}`);
                }
            }
        }

        if (!json && !flags.dryRun) {
            const connectableServiceIds = mergedRegistry
                ? Array.from(new Set(agentIds.flatMap((id) => (
                    resolveConnectTargetServiceIdsFromRegistry(id, mergedRegistry)
                ))))
                : [];
            if (connectableServiceIds.length > 0) {
                const out = createOutputBuilder();
                out.blank();
                out.line(sectionTitle('Next'));
                out.line(bullets(connectableServiceIds.map((serviceId) => (
                    `Connect ${serviceId} credentials in Happier Cloud: ${cmd(`happier connect ${serviceId}`)}`
                ))));
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

    console.error(errorFrame('Error:', [`Unknown agents subcommand: ${subcommand}`]));
    console.log(usage());
    process.exitCode = 1;
}

export async function handleAgentsCliCommand(context: CommandContext): Promise<void> {
    try {
        await handleAgentsCommand(context.args.slice(1));
    } catch (error) {
        const args = context.args.slice(1);
        if (wantsJson(args)) {
            const subcommand = String(args[0] ?? '').trim();
            const kind = subcommand ? `agents_${subcommand}` : 'agents_unknown';
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
