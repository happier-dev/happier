import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import {
    cmd,
    createOutputBuilder,
    errorFrame,
    ok,
    renderHelpPage,
    type HelpPageOptions,
} from '@happier-dev/cli-common/output';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { readCredentials, readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import {
    syncInstalledFirstPartyShims,
    writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { getAgentCliSetupRecommendedIds } from '@happier-dev/agents';
import { resolvePublicReleaseRingIdForLabel } from '@happier-dev/release-runtime/releaseRings';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
    applyBackgroundServiceSetupGuidance,
    readBackgroundServiceSetupGuidance,
    type BackgroundServiceSetupGuidance,
    formatBackgroundServiceReleaseChannelSwitchPrompt,
    formatBackgroundServiceManualRelayTakeoverPrompt,
    formatBackgroundServiceReplacementPrompt,
} from '@happier-dev/cli-common/systemTasks';

function buildSetupHelpPage(): HelpPageOptions {
    const recommendedProviderIds = getAgentCliSetupRecommendedIds();
    const providerExample = recommendedProviderIds.length > 0
        ? `happier setup --relay-url https://relay.example.test ${recommendedProviderIds.map((id) => `--provider ${id}`).join(' ')}`
        : 'happier setup --relay-url https://relay.example.test --provider <id>';
    return {
        title: 'setup',
        subtitle: 'Guided setup',
        usage: [
            {
                label: cmd('happier setup [--relay-url <url>] [--provider <id> ...] [--skip-daemon] [--skip-providers] [--yes]'),
                description: 'Runs setup on this computer.',
            },
            {
                label: cmd('happier setup plan [--relay-url <url>] [--json]'),
                description: 'Prints the planned steps without running them.',
            },
        ],
        sections: [
            {
                title: 'Examples:',
                rows: [
                    { label: cmd('happier setup --relay-url https://relay.example.test'), description: '' },
                    { label: cmd(providerExample), description: '' },
                    { label: cmd('happier setup plan --relay-url https://relay.example.test'), description: '' },
                ],
            },
        ],
        notes: [
            'Sets up this computer for a server (server selection → auth → background service → providers).',
            'In non-interactive environments, pass --yes.',
        ],
    };
}

function argvValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function takeFlag(args: readonly string[], flag: string): Readonly<{ present: boolean; rest: string[] }> {
    const rest: string[] = [];
    let present = false;
    for (const arg of args) {
        if (arg === flag) {
            present = true;
            continue;
        }
        rest.push(arg);
    }
    return { present, rest };
}

function takeRepeatedFlagValues(args: readonly string[], flag: string): Readonly<{ values: string[]; rest: string[] }> {
    const rest: string[] = [];
    const values: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const current = String(args[index] ?? '');
        if (current === flag) {
            const next = String(args[index + 1] ?? '');
            if (!next || next.startsWith('--')) {
                throw new Error(`Missing value for ${flag}`);
            }
            values.push(next);
            index += 1;
            continue;
        }
        rest.push(current);
    }
    return { values, rest };
}

function normalizeRelayUrl(raw: string): string {
    return raw.trim().replace(/\/+$/u, '');
}

type SetupStep = Readonly<{
    id: 'auth_login' | 'daemon_install' | 'daemon_start' | 'providers_setup';
    argv: readonly string[];
    display: string;
}>;

type SetupPlan = Readonly<{
    relayUrl: string;
    steps: readonly SetupStep[];
}>;

function buildSetupPlan(params: Readonly<{
    relayUrl: string;
    includeAuth: boolean;
    includeDaemon: boolean;
    includeProviders: boolean;
    providers: readonly string[];
    assumeYes: boolean;
}>): SetupPlan {
    const relayUrl = normalizeRelayUrl(params.relayUrl);
    const steps: SetupStep[] = [];
    if (params.includeAuth) {
        steps.push({
            id: 'auth_login',
            argv: ['auth', 'login'],
            display: 'happier auth login',
        });
    }
    if (params.includeDaemon) {
        steps.push({
            id: 'daemon_install',
            argv: ['service', 'install'],
            display: 'happier service install',
        });
        steps.push({
            id: 'daemon_start',
            argv: ['service', 'start'],
            display: 'happier service start',
        });
    }
    if (params.includeProviders) {
        const yesArgv = params.assumeYes ? ['--yes'] : [];
        const providerArgv = params.providers.flatMap((id) => ['--provider', id]);
        steps.push({
            id: 'providers_setup',
            argv: ['providers', 'setup', ...providerArgv, ...yesArgv],
            display: providerArgv.length > 0
                ? `happier providers setup ${params.providers.map((id) => `--provider ${id}`).join(' ')}${params.assumeYes ? ' --yes' : ''}`
                : `happier providers setup${params.assumeYes ? ' --yes' : ''}`,
        });
    }
    return { relayUrl, steps };
}

async function runHappyCliStep(args: readonly string[], opts?: Readonly<{ env?: NodeJS.ProcessEnv }>): Promise<number> {
    const child = spawnHappyCLI([...args], {
        stdio: 'inherit',
        env: opts?.env,
        shell: false,
    });
    return await new Promise<number>((resolve) => {
        child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
        child.once('error', () => resolve(1));
    });
}

type SetupCommandDeps = Readonly<{
    readCredentialsFn?: typeof readCredentials;
    readSettingsFn?: typeof readSettings;
    isInteractiveTerminalFn?: typeof isInteractiveTerminal;
    promptInputFn?: typeof promptInput;
    runHappyCliStepFn?: typeof runHappyCliStep;
    applyServerSelectionFromArgs?: typeof applyServerSelectionFromArgs;
    readBackgroundServiceSetupGuidanceFn?: typeof readBackgroundServiceSetupGuidance;
    writeDefaultManagedReleaseChannelFn?: typeof writeDefaultManagedReleaseChannel;
    syncInstalledFirstPartyShimsFn?: typeof syncInstalledFirstPartyShims;
}>;

function mapRelayUrlToServerSelectionArgs(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const current = String(args[index] ?? '');
        if (current === '--relay-url') {
            const next = String(args[index + 1] ?? '');
            if (!next || next.startsWith('--')) {
                throw new Error('Missing value for --relay-url');
            }
            out.push('--server-url', next);
            index += 1;
            continue;
        }
        if (current.startsWith('--relay-url=')) {
            const next = current.slice('--relay-url='.length);
            if (!next) {
                throw new Error('Missing value for --relay-url');
            }
            out.push(`--server-url=${next}`);
            continue;
        }
        out.push(current);
    }
    return out;
}

function ensurePersistWhenServerUrlIsProvided(args: readonly string[]): string[] {
    const hasServerUrl = args.some((a) => a === '--server-url' || String(a).startsWith('--server-url='));
    const hasPersistMode = args.includes('--persist') || args.includes('--no-persist');
    if (!hasServerUrl || hasPersistMode) return [...args];

    const currentServerUrl = normalizeRelayUrl(configuration.serverUrl);
    for (let index = 0; index < args.length; index += 1) {
        const current = String(args[index] ?? '');
        if (current === '--server-url') {
            const next = String(args[index + 1] ?? '');
            if (next && !next.startsWith('--') && normalizeRelayUrl(next) === currentServerUrl) {
                return [...args];
            }
        }
        if (current.startsWith('--server-url=')) {
            const next = current.slice('--server-url='.length);
            if (next && normalizeRelayUrl(next) === currentServerUrl) {
                return [...args];
            }
        }
    }
    const copied = [...args];
    for (let index = 0; index < copied.length; index += 1) {
        const current = String(copied[index] ?? '');
        if (current === '--server-url') {
            const insertAt = Math.min(index + 2, copied.length);
            copied.splice(insertAt, 0, '--persist');
            return copied;
        }
        if (current.startsWith('--server-url=')) {
            copied.splice(index + 1, 0, '--persist');
            return copied;
        }
    }
    return [...copied, '--persist'];
}

function readExplicitRelayUrl(args: readonly string[]): string | null {
    return (
        argvValue(args, '--relay-url')
        ?? argvValue(args, '--server-url')
        ?? args.find((arg) => String(arg).startsWith('--relay-url='))?.slice('--relay-url='.length)
        ?? args.find((arg) => String(arg).startsWith('--server-url='))?.slice('--server-url='.length)
        ?? null
    );
}

function stripSetupRelaySelectionArgs(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const current = String(args[index] ?? '');
        if (current === '--relay-url' || current === '--server-url' || current === '--local-server-url' || current === '--webapp-url') {
            index += 1;
            continue;
        }
        if (current === '--persist' || current === '--no-persist') {
            continue;
        }
        if (
            current.startsWith('--relay-url=')
            || current.startsWith('--server-url=')
            || current.startsWith('--local-server-url=')
            || current.startsWith('--webapp-url=')
        ) {
            continue;
        }
        out.push(current);
    }
    return out;
}

export async function handleSetupCommand(args: string[], deps: SetupCommandDeps = {}): Promise<void> {
    const readCredentialsFn = deps.readCredentialsFn ?? readCredentials;
    const readSettingsFn = deps.readSettingsFn ?? readSettings;
    const isInteractiveTerminalFn = deps.isInteractiveTerminalFn ?? isInteractiveTerminal;
    const promptInputFn = deps.promptInputFn ?? promptInput;
    const runHappyCliStepFn = deps.runHappyCliStepFn ?? runHappyCliStep;
    const applyServerSelectionFromArgsFn = deps.applyServerSelectionFromArgs ?? applyServerSelectionFromArgs;
    const readBackgroundServiceSetupGuidanceFn = deps.readBackgroundServiceSetupGuidanceFn ?? readBackgroundServiceSetupGuidance;
    const writeDefaultManagedReleaseChannelFn = deps.writeDefaultManagedReleaseChannelFn ?? writeDefaultManagedReleaseChannel;
    const syncInstalledFirstPartyShimsFn = deps.syncInstalledFirstPartyShimsFn ?? syncInstalledFirstPartyShims;

    const json = wantsJson(args);
    const wantsHelp = args.includes('--help') || args.includes('-h') || args.includes('help');
    if (wantsHelp) {
        console.log(renderHelpPage(buildSetupHelpPage()));
        return;
    }

    const planMode = String(args[0] ?? '').trim() === 'plan';
    const kind = planMode ? 'setup_plan' : 'setup';
    if (json && !planMode) {
        throw new Error('`--json` is only supported with `happier setup plan`.');
    }

    const argsForRun = planMode ? args.slice(1) : args;
    const explicitRelayUrl = readExplicitRelayUrl(argsForRun);
    const currentRelayUrl = normalizeRelayUrl(configuration.serverUrl);
    const explicitRelayUrlMatchesCurrent = explicitRelayUrl != null && normalizeRelayUrl(explicitRelayUrl) === currentRelayUrl;
    const hasRelaySelectionOverrides =
        argsForRun.some((arg) => {
            const value = String(arg ?? '');
            return (
                value === '--server'
                || value.startsWith('--server=')
                || value === '--local-server-url'
                || value.startsWith('--local-server-url=')
                || value === '--webapp-url'
                || value.startsWith('--webapp-url=')
            );
        });

    let argsAfterServerSelection = stripSetupRelaySelectionArgs(argsForRun);
    if (!explicitRelayUrlMatchesCurrent || hasRelaySelectionOverrides) {
        argsAfterServerSelection = ensurePersistWhenServerUrlIsProvided(mapRelayUrlToServerSelectionArgs(argsForRun));
        argsAfterServerSelection = await applyServerSelectionFromArgsFn(argsAfterServerSelection);
    }

    const relayUrl = normalizeRelayUrl(explicitRelayUrl ?? configuration.serverUrl);

    const { present: skipDaemon, rest: withoutSkipDaemon } = takeFlag(argsAfterServerSelection, '--skip-daemon');
    const { present: skipProviders, rest: withoutSkipProviders } = takeFlag(withoutSkipDaemon, '--skip-providers');
    const { values: providers, rest: remaining } = takeRepeatedFlagValues(withoutSkipProviders, '--provider');
    const { present: yesFlag } = takeFlag(remaining, '--yes');

    const credentials = await readCredentialsFn().catch(() => null);
    const settings = await readSettingsFn().catch(() => null);
    const machineId = settings?.machineId;
    const machineRegistered = typeof machineId === 'string' && machineId.trim().length > 0;
    const includeAuth = credentials == null || !machineRegistered;

    const plan = buildSetupPlan({
        relayUrl,
        includeAuth,
        includeDaemon: !skipDaemon,
        includeProviders: !skipProviders,
        providers,
        assumeYes: yesFlag,
    });

    if (planMode) {
        if (json) {
            printJsonEnvelope({
                ok: true,
                kind,
                data: {
                    relayUrl: plan.relayUrl,
                    steps: plan.steps.map((step) => ({
                        id: step.id,
                        command: step.display,
                        argv: step.argv,
                    })),
                },
            });
            return;
        }
        const out = createOutputBuilder();
        out.section('Setup plan', (section) => {
            section.definitionList([{ label: 'Server', value: plan.relayUrl }], { indent: '  ' });
            section.blank();
            section.numbered(plan.steps.map((step) => step.display));
        });
        console.log(out.render());
        return;
    }

    if (!yesFlag) {
        if (!isInteractiveTerminalFn()) {
            throw new Error('Non-interactive mode: pass --yes to run setup.');
        }
        const confirm = (await promptInputFn('Run setup now? [Y/n] ')).trim().toLowerCase();
        if (confirm.startsWith('n')) {
            const out = createOutputBuilder();
            out.line('Aborted.');
            console.log(out.render());
            return;
        }
    }

    const daemonSetupPreflightSteps: string[][] = [];
    let daemonStepOverrides: readonly Readonly<{ id: 'daemon_install' | 'daemon_start'; argv: readonly string[]; display: string }>[] =
      skipDaemon
        ? []
        : [
            {
                id: 'daemon_install',
                argv: ['service', 'install'],
                display: 'happier service install',
            },
            {
                id: 'daemon_start',
                argv: ['service', 'start'],
                display: 'happier service start',
            },
        ];
    if (!skipDaemon) {
        const guidance = await readBackgroundServiceSetupGuidanceFn({
            targetReleaseChannel: configuration.publicReleaseRing,
            targetServerUrl: relayUrl,
        });

        if (
            (
                guidance.shouldOfferDefaultReleaseChannelSwitch
                || guidance.shouldPromptForManualRelayTakeover
                || guidance.shouldPromptForServiceReplacement
            )
            && !isInteractiveTerminalFn()
        ) {
            throw new Error('Background service setup requires interactive guidance. Re-run in an interactive terminal or pass --skip-daemon.');
        }

        const guidanceResult = await applyBackgroundServiceSetupGuidance({
            guidance,
            promptSwitchDefaultReleaseChannel: async () => await promptForSetupReleaseChannelSwitch({
                promptInputFn,
                guidance,
            }),
            promptTakeOverManualRelayRuntime: async () => await promptForSetupManualRelayTakeover({
                promptInputFn,
                guidance,
            }),
            promptReplaceExistingServices: async () => await promptForSetupServiceReplacement({
                promptInputFn,
                guidance,
            }),
            switchDefaultReleaseChannel: async () => {
                const targetReleaseChannelId: PublicReleaseRingId = resolvePublicReleaseRingIdForLabel(guidance.targetReleaseChannel);
                await writeDefaultManagedReleaseChannelFn({
                    processEnv: process.env,
                    releaseChannel: targetReleaseChannelId,
                });
                await syncInstalledFirstPartyShimsFn({
                    componentId: 'happier-cli',
                    channel: targetReleaseChannelId,
                    processEnv: process.env,
                });
            },
            takeOverManualRelayRuntime: async () => undefined,
            replaceExistingServices: async () => {
                daemonSetupPreflightSteps.push(['service', 'uninstall', '--all', '--yes']);
            },
        });

        if (guidanceResult.cancelled) {
            const out = createOutputBuilder();
            out.line('Aborted.');
            console.log(out.render());
            return;
        }

        if (guidance.exactDefaultServiceExists && !guidanceResult.replacedExistingServices) {
            daemonStepOverrides = guidanceResult.tookOverManualRelayRuntime
                ? [{
                    id: 'daemon_start',
                    argv: ['service', 'start', '--takeover'],
                    display: 'happier service start --takeover',
                }]
                : [];
        } else {
            daemonStepOverrides = [
                {
                    id: 'daemon_install',
                    argv: ['service', 'install', ...(guidanceResult.tookOverManualRelayRuntime ? ['--takeover'] : [])],
                    display: `happier service install${guidanceResult.tookOverManualRelayRuntime ? ' --takeover' : ''}`,
                },
                {
                    id: 'daemon_start',
                    argv: ['service', 'start', ...(guidanceResult.tookOverManualRelayRuntime ? ['--takeover'] : [])],
                    display: `happier service start${guidanceResult.tookOverManualRelayRuntime ? ' --takeover' : ''}`,
                },
            ];
        }
    }

    const setupSteps = plan.steps.flatMap((step) => {
        if (step.id !== 'daemon_install' && step.id !== 'daemon_start') {
            return [step];
        }
        const override = daemonStepOverrides.find((entry) => entry.id === step.id);
        if (!override) {
            return [];
        }
        return [{
            ...step,
            argv: override.argv,
            display: override.display,
        }];
    });
    for (const step of [...daemonSetupPreflightSteps.map((argv) => ({ argv })), ...setupSteps]) {
        const exitCode = await runHappyCliStepFn(step.argv);
        if (exitCode !== 0) {
            const display = 'display' in step ? step.display : `happier ${step.argv.join(' ')}`;
            console.error(errorFrame('Error:', [`Setup step failed (exit ${exitCode}): ${display}`]));
            process.exitCode = exitCode;
            return;
        }
    }

    const out = createOutputBuilder();
    out.line(ok('Setup complete.'));
    console.log(out.render());
}

export async function handleSetupCliCommand(context: CommandContext): Promise<void> {
    await handleSetupCommand(context.args.slice(1));
}

async function promptForSetupReleaseChannelSwitch(params: Readonly<{
    promptInputFn: typeof promptInput;
    guidance: BackgroundServiceSetupGuidance;
}>): Promise<boolean> {
    const answer = (await params.promptInputFn(
        `${formatBackgroundServiceReleaseChannelSwitchPrompt(params.guidance)} [Y/n] `,
    )).trim().toLowerCase();
    return !answer.startsWith('n');
}

async function promptForSetupServiceReplacement(params: Readonly<{
    promptInputFn: typeof promptInput;
    guidance: BackgroundServiceSetupGuidance;
}>): Promise<boolean> {
    const answer = (await params.promptInputFn(
        `${formatBackgroundServiceReplacementPrompt(params.guidance)} [Y/n] `,
    )).trim().toLowerCase();
    return !answer.startsWith('n');
}

async function promptForSetupManualRelayTakeover(params: Readonly<{
    promptInputFn: typeof promptInput;
    guidance: BackgroundServiceSetupGuidance;
}>): Promise<boolean> {
    const answer = (await params.promptInputFn(
        `${formatBackgroundServiceManualRelayTakeoverPrompt(params.guidance)} [Y/n] `,
    )).trim().toLowerCase();
    return !answer.startsWith('n');
}
