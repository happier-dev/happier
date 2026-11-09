import { usage } from './agents/help';
import { readResolvedAgentTitle as readAgentTitle } from '@/plugins/projection/registry/agentCommandTitle';
import {
    getAgentCliSetupRecommendedIds,
    resolveCanonicalAgentIdFromFlavor,
} from '@happier-dev/agents';
import {
    installAgentCliForRuntime,
    planAgentCliInstallForRuntime,
    resolvePlatformFromNodePlatform,
    resolveAgentCliCommandForRuntime,
    type InstallAgentCliResult,
    type AgentCliCommandResolution,
    type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import type { ResolvedContributionRegistry, ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptMultipleSelection } from '@/terminal/prompts/promptMultipleChoice';
import { cmd, createOutputBuilder, dim, errorFrame, kv, neutral, ok, renderHelpPage } from '@happier-dev/cli-common/output';
import type { CapabilityId } from '@happier-dev/protocol';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { tryHandleAgentCliCommand, type AgentCliInstallOutcome } from '@/cli/actions/adapters/agentsArgv';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand, type ActionCliExecutionDeps } from '@/cli/actions/executeCommand';


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

function parseInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean; vendorConsent: boolean }> {
    return {
        dryRun: args.includes('--dry-run'),
        skipIfInstalled: !args.includes('--force'),
        vendorConsent: args.includes('--yes') || args.includes('--allow-vendor-recipe'),
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

async function printUnknownAgentJsonEnvelope(kind: string, agentId: string): Promise<void> {
    await printJsonEnvelope({
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

function listAgentStatus(
    registry: Pick<ResolvedContributionRegistry, 'agents'>,
    processEnv: NodeJS.ProcessEnv,
): AgentStatusRow[] {
    return registry.agents
        .filter((contribution) => !contribution.identity || listAgentExecutionTargetsV1(contribution.identity).length > 0)
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

type AgentsInstallResult = Readonly<{
    plan: Extract<InstallAgentCliResult, { ok: true }>['plan'] | null;
    logPath: string | null;
    jobId?: string;
    version?: string | null;
}> & (Readonly<{ ok: true; alreadyInstalled: boolean }> | Readonly<{
    ok: false; errorCode: string; errorMessage: string; stepId?: string; guideUrl?: string;
}>);

async function runAgentsInstallDryRun(
    runtimeSpec: AgentCliRuntimeDescriptor,
    flags: ReturnType<typeof parseInstallFlags>,
    intent: 'install' | 'update' = 'install',
): Promise<AgentsInstallResult> {
    const platform = resolvePlatformFromNodePlatform(process.platform);
    const planned = platform ? planAgentCliInstallForRuntime({ runtimeSpec, platform }) : null;
    const plan = planned?.ok ? planned.plan : null;
    const resolution = resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv: process.env });
    if (!platform) return { ok: false, errorCode: 'unsupported_platform', errorMessage: `Unsupported platform: ${process.platform}`, plan, logPath: null };
    if (intent === 'update' && !resolution) {
        return { ok: false, errorCode: 'update_not_available', errorMessage: 'The agent CLI must be installed before it can be updated.', plan, logPath: null };
    }
    return await installAgentCliForRuntime({
        runtimeSpec, platform, env: process.env, dryRun: true,
        skipIfInstalled: flags.skipIfInstalled, allowVendorRecipeExecution: false,
        intent,
        ...(intent === 'update' && resolution ? { updateTarget: { command: resolution.command, source: resolution.source } } : {}),
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
    const combined = Array.from(new Set([...explicit, ...csv].map(value => supportedById.has(value)
        ? value : resolveCanonicalAgentIdFromFlavor(value) ?? value)));
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
        return getAgentCliSetupRecommendedIds().filter(
            (id) => supportedById.has(id) && !supportedById.get(id)?.installed,
        );
    }

    const missingRows = supportedRows.filter((row) => !row.installed);
    const recommended = new Set<string>(getAgentCliSetupRecommendedIds());
    const installedTitles = supportedRows.filter((row) => row.installed).map((row) => row.title);
    const message = installedTitles.length > 0
        ? `Choose optional coding agents to add. Already installed: ${installedTitles.join(', ')}.`
        : 'Choose coding agents to install.';
    return await promptMultipleSelection(message, [
        ...missingRows.map((row) => ({
            id: row.id,
            label: `${row.title} (${row.id})`,
            description: row.runtimeSpec.managedInstall
                ? 'Happier-managed install'
                : row.runtimeSpec.manualInstallKind === 'vendor_recipe'
                    ? 'Runs the agent vendor installer'
                    : 'Uses the catalog install command',
            selected: recommended.has(row.id),
        })),
        { id: 'skip', label: 'Skip for now', kind: 'skip' as const },
    ]);
}

export async function handleAgentsCommand(args: string[], options: Readonly<{ signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps> }> = {}): Promise<void> {
    const subcommand = String(args[0] ?? '').trim();
    const json = wantsJson(args);
    if (['', 'help', '--help', '-h', 'list', 'status'].includes(subcommand)) {
        const { resolveAdmittedAgentListingContributions } = await import('@/plugins/projection/registry/admittedAgents');
        const agentRows = listAgentStatus(await resolveAdmittedAgentListingContributions(configuration.happyHomeDir), process.env);
        if (subcommand === 'list' || subcommand === 'status') {
            if (json) {
                await printJsonEnvelope({
                    ok: true,
                    kind: subcommand === 'list' ? 'agents_list' : 'agents_status',
                    data: { agents: agentRows.map((row) => ({
                        id: row.id, title: row.title, installed: row.installed,
                        source: row.resolution?.source ?? null, command: row.resolution?.command ?? null,
                    })) },
                });
            } else {
                printHumanStatus(agentRows);
            }
        } else {
            console.log(usage(agentRows));
        }
        return;
    }
    const argv = ['agents', ...args];
    const localPlan = (args[0] === 'install' || args[0] === 'update') && args.includes('--dry-run');
    if (!localPlan && await tryHandleAgentCliCommand({ argv, ...options })) return;
    const compiled = findCompiledActionCliCommand(argv, listCompiledActionCliCommands());
    if (compiled && !args.includes('--dry-run')) {
        await runCompiledActionCliCommand({ command: compiled, argv, signal: options.signal, deps: options.actionExecutionDeps });
        return;
    }
    const kind = (() => {
        if (!subcommand) return 'agents_unknown';
        if (subcommand === 'probe') return 'agents_probe';
        if (subcommand === 'auth') return 'agents_auth';
        if (subcommand === 'install') return 'agents_install';
        if (subcommand === 'setup') return 'agents_setup';
        return `agents_${subcommand}`;
    })();

    const needsAgentRegistry =
        subcommand === 'probe'
        || subcommand === 'auth'
        || subcommand === 'install'
        || subcommand === 'update'
        || subcommand === 'setup';
    const mergedRegistry = needsAgentRegistry
        ? await (await import('@/plugins/projection/registry/createResolvedContributionRegistry')).resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
        : null;
    const agentRows = needsAgentRegistry
        ? listAgentStatus(mergedRegistry!, process.env)
        : [];
    const agentRowsById = new Map(agentRows.map((row) => [row.id, row] as const));
    const readAgentRow = (requestedId: string) => agentRowsById.get(requestedId)
        ?? agentRowsById.get(resolveCanonicalAgentIdFromFlavor(requestedId) ?? requestedId);

    if (subcommand === 'probe') {
        const requestedId = String(args[1] ?? '').trim();
        if (!requestedId || requestedId === 'help' || requestedId === '--help' || requestedId === '-h') {
            console.log(usage(agentRows));
            return;
        }
        const agentRow = readAgentRow(requestedId);
        if (!agentRow) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, requestedId);
                return;
            }
            throw new Error(`Unknown agent id: ${requestedId}`);
        }
        const agentId = agentRow.id;

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
                    await printJsonEnvelope({
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
            await printJsonEnvelope({
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

    if (subcommand === 'auth') {
        const action = String(args[1] ?? '').trim();
        const requestedId = String(args[2] ?? '').trim();
        if (action !== 'login' || !requestedId || args.includes('--help') || args.includes('-h')) {
            console.log(usage(agentRows));
            return;
        }
        const agentRow = readAgentRow(requestedId);
        if (!agentRow || !mergedRegistry) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, requestedId);
                return;
            }
            throw new Error(`Unknown agent id: ${requestedId}`);
        }
        const agentId = agentRow.id;
        const controller = new AbortController();
        const onInterrupt = () => controller.abort(new DOMException('Agent login cancelled', 'AbortError'));
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);
        try {
            const { authenticateDeclaredAcpAgent } = await import('@/agent/acp/authenticateDeclaredAcpAgent');
            console.log(`Signing in to ${agentRow.title}. Follow its browser login link if requested.`);
            await authenticateDeclaredAcpAgent({
                registry: mergedRegistry,
                agentId,
                cwd: process.cwd(),
                env: process.env,
                signal: controller.signal,
                onStderr: (text) => { process.stderr.write(text); },
            });
            console.log(`${agentRow.title} login completed.`);
        } finally {
            process.removeListener('SIGINT', onInterrupt);
            process.removeListener('SIGTERM', onInterrupt);
        }
        return;
    }

    if (subcommand === 'install' || subcommand === 'update') {
        const agentIdRaw = String(args[1] ?? '').trim();
        if (!agentIdRaw || agentIdRaw === 'help' || agentIdRaw === '--help' || agentIdRaw === '-h') {
            console.log(usage());
            return;
        }
        const agentRow = readAgentRow(agentIdRaw);
        if (!agentRow) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, agentIdRaw);
                return;
            }
            throw new Error(`Unknown agent id: ${agentIdRaw}`);
        }
        if (!agentRow.runtimeSpec) {
            const message = `Agent '${agentIdRaw}' does not publish a CLI installation recipe.`;
            if (json) {
                await printJsonEnvelope({
                    ok: false,
                    kind,
                    error: { code: 'agent_install_unsupported', message, agentId: agentIdRaw },
                }, { exitCode: 1 });
                return;
            }
            throw new Error(message);
        }
        const flags = parseInstallFlags(args.slice(2));
        const result = await runAgentsInstallDryRun(agentRow.runtimeSpec, flags, subcommand);
        if (json) {
            if (result.ok) {
                await printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            agentId: agentRow.id,
                            alreadyInstalled: result.alreadyInstalled ?? false,
                            plan: result.plan,
                            logPath: result.logPath ?? null,
                            jobId: result.jobId ?? null,
                            version: result.version ?? null,
                        },
                    },
                    { exitCode: 0 },
                );
                return;
            }
            await printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: result.errorCode,
                        message: result.errorMessage,
                        logPath: result.logPath ?? null,
                        jobId: result.jobId ?? null,
                        ...(result.stepId ? { stepId: result.stepId } : {}),
                        ...(result.guideUrl ? { guideUrl: result.guideUrl } : {}),
                    },
                },
                { exitCode: 1 },
            );
            return;
        }

        if (!result.ok) {
            console.error(errorFrame('Error:', [result.errorMessage,
                ...(result.guideUrl ? [`Installation guide: ${result.guideUrl}`] : []),
                ...(result.logPath ? [`Install log: ${result.logPath}`] : []),
            ]));
            process.exitCode = 1;
            return;
        }

        const out = createOutputBuilder();
        out.line(`Dry run: would ${subcommand} ${agentRow.title} via ${result.plan?.installMode ?? 'its catalog recipe'}.`);
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
                await printJsonEnvelope({
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
                await printJsonEnvelope({ ok: true, kind, data: { agents: [] } });
                return;
            }
            console.log(neutral('(no agents selected)'));
            return;
        }

        if (flags.dryRun) {
            const results = [];
            for (const agentId of agentIds) {
                const row = agentRowsById.get(agentId);
                if (!row?.runtimeSpec) throw new Error(`Agent '${agentId}' does not publish a CLI installation recipe.`);
                results.push({ agentId, ...await runAgentsInstallDryRun(row.runtimeSpec, flags) });
            }
            if (json) {
                const allOk = results.every(result => result.ok);
                await printJsonEnvelope(allOk ? { ok: true, kind, data: { agents: results } }
                    : { ok: false, kind, error: { code: 'install_failed', agents: results } });
            }
            else for (const result of results) console.log(result.ok
                ? `Dry run: would install ${result.agentId} via ${result.plan?.installMode ?? 'its catalog recipe'}.`
                : result.errorMessage);
        } else {
            const receipts: AgentCliInstallOutcome[] = [];
            for (const agentId of agentIds) {
                await tryHandleAgentCliCommand({ argv: ['agents', 'install', agentId,
                    ...(flags.vendorConsent ? ['--allow-vendor-recipe'] : []),
                    ...(!flags.skipIfInstalled ? ['--force'] : []),
                    ...(readSingleFlagValue(args, '--server-id') ? ['--server-id', readSingleFlagValue(args, '--server-id')!] : []),
                    ...(json ? ['--json'] : [])], ...options,
                    ...(json ? { consumeInstallOutcome: (receipt: AgentCliInstallOutcome) => { receipts.push(receipt); return true; } } : {}) });
                // A failed admission has already been presented by the compiler.
                if (json && receipts.length < agentIds.indexOf(agentId) + 1) return;
            }
            if (json) {
                const allOk = receipts.every(receipt => receipt.outcome.kind === 'succeeded');
                const agents = receipts.map(receipt => ({ agentId: receipt.agentId, jobId: receipt.jobId,
                    ok: receipt.outcome.kind === 'succeeded', installed: receipt.outcome.kind === 'succeeded',
                    version: receipt.outcome.kind === 'succeeded' ? receipt.outcome.version : null,
                    errorMessage: receipt.outcome.kind === 'failed' ? receipt.outcome.message : null,
                    errorCode: receipt.outcome.kind === 'failed' ? receipt.outcome.code : null,
                    alreadyInstalled: null, plan: null, logPath: null,
                }));
                await printJsonEnvelope(allOk ? { ok: true, kind, data: { agents } }
                    : { ok: false, kind, error: { code: 'install_failed', agents } }, { exitCode: allOk ? 0 : 1 });
            }
        }
        return;
    }

    if (json) {
        await printJsonEnvelope({ ok: false, kind, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
        return;
    }

    console.error(errorFrame('Error:', [`Unknown agents subcommand: ${subcommand}`]));
    console.log(usage());
    process.exitCode = 1;
}

export async function handleAgentsCliCommand(context: CommandContext): Promise<void> {
    try {
        await handleAgentsCommand(context.args.slice(1), { signal: context.signal });
    } catch (error) {
        const args = context.args.slice(1);
        if (wantsJson(args)) {
            const subcommand = String(args[0] ?? '').trim();
            const kind = subcommand ? `agents_${subcommand}` : 'agents_unknown';
            await printJsonEnvelope(
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
