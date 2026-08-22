import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import {
    cmd,
    createOutputBuilder,
    errorFrame,
    neutral,
    ok,
    renderHelpPage,
    warn,
    type HelpPageOptions,
} from '@happier-dev/cli-common/output';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { readSettings, readStoredCredentials } from '@/persistence';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { configuration, reloadConfiguration } from '@/configuration';
import { applyServerSelectionFromArgs, resolveServerSelectionFromArgs } from '@/server/serverSelection';
import {
    syncInstalledFirstPartyShims,
    writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { AGENT_IDS, getAgentCliSetupRecommendedIds } from '@happier-dev/agents';
import { relayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessProviderDescriptor, RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import { resolvePublicReleaseRingIdForLabel } from '@happier-dev/release-runtime/releaseRings';
import { defaultNameFromUrl } from './server/commandUtilities';
import { DEFER_SERVER_SELECTION_FOLLOW_UP_ENV } from './backgroundServiceFollowUp';

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
                label: cmd('happier setup [--relay-url <url>] [--provider <id> ...] [--skip-daemon] [--skip-providers] [--yes|--non-interactive]'),
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
            'Sets up this computer for a server (server selection → auth → background service → agents).',
            'Asks where your relay lives — Happier Cloud, a server you already run, or one on this computer — when this computer has no account on its current server yet. Your account lives on the server you pick, so it is settled before sign-in.',
            'Pass --relay-url (or --server) to answer that up front and skip the question.',
            '--yes performs deterministic work for an explicitly named relay, then stops before sign-in. --non-interactive changes nothing.',
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

function childEnvWithDeferredServerSelectionFollowUp(): NodeJS.ProcessEnv {
    return { ...process.env, [DEFER_SERVER_SELECTION_FOLLOW_UP_ENV]: '1' };
}

type SetupStep = Readonly<{
    id: 'auth_login' | 'daemon_install' | 'daemon_start' | 'agents_setup';
    argv: readonly string[];
    display: string;
}>;

const SETUP_AUTH_WAIT_TIMEOUT_SECONDS = 5 * 60;

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
        const methodArgs = isLoopbackServerHost(relayUrl) ? ['--method', 'web'] : [];
        steps.push({
            id: 'auth_login',
            argv: ['auth', 'login', '--wait-timeout', String(SETUP_AUTH_WAIT_TIMEOUT_SECONDS), ...methodArgs],
            display: `happier auth login --wait-timeout ${SETUP_AUTH_WAIT_TIMEOUT_SECONDS}${methodArgs.length > 0 ? ' --method web' : ''}`,
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
            id: 'agents_setup',
            argv: ['agents', 'setup', ...providerArgv, ...yesArgv],
            display: providerArgv.length > 0
                ? `happier agents setup ${params.providers.map((id) => `--provider ${id}`).join(' ')}${params.assumeYes ? ' --yes' : ''}`
                : `happier agents setup${params.assumeYes ? ' --yes' : ''}`,
        });
    }
    return { relayUrl, steps };
}

async function runHappyCliStep(
    args: readonly string[],
    opts?: Readonly<{ env?: NodeJS.ProcessEnv }>,
): Promise<number> {
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

/**
 * The bundled agent CLIs that actually resolve on this computer.
 *
 * `AGENT_IDS` is the bundled agent list and, by construction, excludes the
 * `customAcp` compatibility family — that is a way of pointing Happier at an ACP
 * binary, not an installable CLI, so it could never answer "is an agent here".
 */
async function listInstalledAgentIds(): Promise<readonly string[]> {
    // Loaded on demand. Agent CLI resolution drags in the whole install/runtime
    // graph, and every setup path except this one final check gets there without it.
    const { resolveAgentCliCommand } = await import('@/packagedRuntime/managedTools/agentCliResolution');
    return AGENT_IDS.filter((agentId) => {
        try {
            return resolveAgentCliCommand(agentId, { processEnv: process.env }) !== null;
        } catch {
            // A resolver failure means "not usable here", which is what we asked.
            return false;
        }
    });
}

/**
 * Happier runs a coding agent and ships none, so a machine that finishes setup
 * without one is paired but unusable — and today that only surfaces later, as a
 * resolver error at the start of the first session. Say it here instead. It
 * never blocks: an agent can be installed afterwards, from this same shell.
 */
function printNoCodingAgentWarning(): void {
    const recommendedIds = getAgentCliSetupRecommendedIds();
    const out = createOutputBuilder();
    out.line(warn('No coding agent found on this computer.'));
    out.blank();
    out.line('Happier runs your coding agent; it does not ship one. Install at least one:');
    if (recommendedIds.length > 0) {
        out.blank();
        for (const agentId of recommendedIds) {
            out.line(`  ${cmd(`happier agents install ${agentId}`)}`);
        }
    }
    out.blank();
    out.line(`  See them all with ${cmd('happier agents list')}, or choose interactively with ${cmd('happier agents setup')}.`);
    console.log(out.render());
}

async function warnWhenNoCodingAgentIsInstalled(
    listInstalledAgentIdsFn: () => Promise<readonly string[]>,
): Promise<void> {
    let installedAgentIds: readonly string[];
    try {
        installedAgentIds = await listInstalledAgentIdsFn();
    } catch {
        // Advisory, so a check that cannot run must not fail a setup that otherwise
        // succeeded — but it must not be silent either.
        const out = createOutputBuilder();
        out.line(neutral(`Could not check which coding agents are installed. Run ${cmd('happier agents list')} to check.`));
        console.log(out.render());
        return;
    }
    if (installedAgentIds.length > 0) return;
    printNoCodingAgentWarning();
}

/**
 * Where the account will live.
 *
 * Credentials are stored per relay profile, so signing in before the relay is
 * settled does not move an account later — it creates a second one. That is why
 * setup asks first, and why every answer resolves through an owner that already
 * exists: the server-selection owner for a hosted or already-running relay,
 * `happier relay host install` for a relay on this computer.
 */
type SetupRelaySelection =
    | Readonly<{ kind: 'cloud' }>
    | Readonly<{ kind: 'existing'; url: string }>
    | Readonly<{ kind: 'thisComputer' }>;

/**
 * Wording reused from the client's own pre-auth screen (`setupOnboarding` in
 * `apps/ui/sources/text/translations/en.ts`) so the terminal and the app ask the
 * same question the same way.
 */
async function askWhereTheRelayLives(promptInputFn: typeof promptInput): Promise<SetupRelaySelection> {
    const choice = await promptMultipleChoice(
        [
            '',
            'Where does your relay live?',
            '',
            'Your relay routes messages between your phone and your computers.',
            'Choose where it lives — you can change this later.',
            '',
            '  c) Happier Cloud       Hosted relay — easiest to start with',
            '  r) A relay I already run',
            '  t) On this computer',
            '',
            'Choose',
        ].join('\n'),
        [
            { id: 'cloud', keys: ['c', 'cloud'], short: 'C' },
            { id: 'existing', keys: ['r', 'relay', 'existing'], short: 'r' },
            { id: 'thisComputer', keys: ['t', 'this'], short: 't' },
        ] as const,
        { defaultId: 'cloud', maxAttempts: 3, promptInputFn },
    );

    if (choice === 'cloud') return { kind: 'cloud' };
    if (choice === 'thisComputer') return { kind: 'thisComputer' };

    const url = (await promptInputFn('Relay URL: ')).trim();
    if (!url) {
        throw new Error('A relay URL is required to continue. Re-run `happier setup` when you have it.');
    }
    return { kind: 'existing', url };
}

/**
 * Prerequisites the user has to supply, as opposed to ones the provider resolves.
 *
 * `happier relay access configure` takes these as flags and refuses to prompt,
 * and a tunnel token passed on argv is readable by every process on the machine.
 * So setup offers the providers whose prerequisites the provider itself settles
 * and names the command for the rest, rather than growing a second, weaker copy
 * of the relay-access wizard.
 */
const RELAY_ACCESS_PREREQUISITE_KINDS_NEEDING_USER_VALUES: ReadonlySet<string> = new Set([
    'manualUrl',
    'cloudflareHostname',
    'cloudflareToken',
]);

function relayAccessProviderNeedsUserSuppliedValues(descriptor: RelayAccessProviderDescriptor): boolean {
    return descriptor.prerequisites.some(
        (prerequisite) => RELAY_ACCESS_PREREQUISITE_KINDS_NEEDING_USER_VALUES.has(prerequisite.kind),
    );
}

type RelayAccessOfferChoice = RelayAccessProviderId | 'skip';

/**
 * A relay bound to loopback is the one address no phone can use, and it is only
 * discovered later and from somewhere else. `relay host install` has already
 * settled which address the relay answers on; what is left is how the phone gets
 * there, and that belongs to the relay-access registry.
 *
 * Never blocking: a declined or failing access method still leaves a working
 * relay and a machine that can finish signing in.
 */
async function offerRelayAccessForLocalRelay(params: Readonly<{
    promptInputFn: typeof promptInput;
    runHappyCliStepFn: typeof runHappyCliStep;
}>): Promise<void> {
    const offerable = relayAccessProviderDescriptors.filter(
        (descriptor) => (
            descriptor.id !== 'localOnly'
            && descriptor.exposure === 'private'
            && !relayAccessProviderNeedsUserSuppliedValues(descriptor)
        ),
    );
    const manual = relayAccessProviderDescriptors.filter(
        (descriptor) => descriptor.id !== 'localOnly' && relayAccessProviderNeedsUserSuppliedValues(descriptor),
    );
    if (offerable.length === 0) return;

    const lines = [
        '',
        'This relay is reachable from this computer only.',
        'How should your phone reach this relay?',
        '',
        '  s) Not now             Keep it local; set this up later',
    ];
    for (const [index, descriptor] of offerable.entries()) {
        lines.push(`  ${index + 1}) ${descriptor.title}`);
    }
    lines.push('', 'Choose');

    const options = [
        { id: 'skip' as const, keys: ['s', 'skip', 'no', 'n'], short: 's' },
        ...offerable.map((descriptor, index) => ({
            id: descriptor.id,
            keys: [String(index + 1), descriptor.id],
            short: String(index + 1),
        })),
    ] satisfies readonly Readonly<{ id: RelayAccessOfferChoice; keys: readonly string[]; short: string }>[];

    const choice = await promptMultipleChoice<RelayAccessOfferChoice>(
        lines.join('\n'),
        options,
        { defaultId: 'skip', maxAttempts: 3, promptInputFn: params.promptInputFn },
    );

    if (choice === 'skip') {
        const out = createOutputBuilder();
        out.line(neutral(`Set it up any time with ${cmd('happier relay access')}.`));
        if (manual.length > 0) {
            out.line(neutral(
                `Methods that need a URL or a token: ${manual.map((descriptor) => descriptor.id).join(', ')}.`,
            ));
        }
        console.log(out.render());
        return;
    }

    const exitCode = await params.runHappyCliStepFn(['relay', 'access', 'configure', '--provider', choice]);
    if (exitCode !== 0) {
        const out = createOutputBuilder();
        out.line(warn(`Could not configure relay access (exit ${exitCode}).`));
        out.line(neutral(`Setup continues. Retry with ${cmd(`happier relay access configure --provider ${choice}`)}.`));
        console.log(out.render());
    }
}

type SetupCommandDeps = Readonly<{
    readCredentialsFn?: typeof readStoredCredentials;
    readSettingsFn?: typeof readSettings;
    isInteractiveTerminalFn?: typeof isInteractiveTerminal;
    promptInputFn?: typeof promptInput;
    runHappyCliStepFn?: typeof runHappyCliStep;
    applyServerSelectionFromArgs?: typeof applyServerSelectionFromArgs;
    resolveServerSelectionFromArgs?: typeof resolveServerSelectionFromArgs;
    readBackgroundServiceSetupGuidanceFn?: typeof readBackgroundServiceSetupGuidance;
    writeDefaultManagedReleaseChannelFn?: typeof writeDefaultManagedReleaseChannel;
    syncInstalledFirstPartyShimsFn?: typeof syncInstalledFirstPartyShims;
    listInstalledAgentIdsFn?: () => Promise<readonly string[]>;
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
    const readCredentialsFn = deps.readCredentialsFn ?? readStoredCredentials;
    const readSettingsFn = deps.readSettingsFn ?? readSettings;
    const isInteractiveTerminalFn = deps.isInteractiveTerminalFn ?? isInteractiveTerminal;
    const promptInputFn = deps.promptInputFn ?? promptInput;
    const runHappyCliStepFn = deps.runHappyCliStepFn ?? runHappyCliStep;
    const applyServerSelectionFromArgsFn = deps.applyServerSelectionFromArgs ?? applyServerSelectionFromArgs;
    const resolveServerSelectionFromArgsFn = deps.resolveServerSelectionFromArgs ?? resolveServerSelectionFromArgs;
    const readBackgroundServiceSetupGuidanceFn = deps.readBackgroundServiceSetupGuidanceFn ?? readBackgroundServiceSetupGuidance;
    const writeDefaultManagedReleaseChannelFn = deps.writeDefaultManagedReleaseChannelFn ?? writeDefaultManagedReleaseChannel;
    const syncInstalledFirstPartyShimsFn = deps.syncInstalledFirstPartyShimsFn ?? syncInstalledFirstPartyShims;
    const listInstalledAgentIdsFn = deps.listInstalledAgentIdsFn ?? listInstalledAgentIds;

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

    // Settled before anything else mutates state, because credentials are stored
    // per relay profile: signing in first and pointing at a self-hosted relay
    // afterwards leaves two accounts rather than a moved one.
    const relayNamedOnCommandLine = explicitRelayUrl != null || hasRelaySelectionOverrides;
    const assumeYesFlag = argsForRun.includes('--yes');
    const forcedNonInteractive = argsForRun.includes('--non-interactive');
    let relayQuestionSelectionArgs: readonly string[] = [];
    let relayQuestionAsked = false;
    let installLocalRelay = false;
    let existingRelayToAdd: string | null = null;

    if (!planMode && forcedNonInteractive) {
        const out = createOutputBuilder();
        out.line(neutral('Non-interactive setup changes nothing. Run `happier setup` in a terminal, or name a relay and pass `--yes`.'));
        console.log(out.render());
        process.exitCode = 1;
        return;
    }

    // `--yes` authorizes deterministic work, but it cannot choose the relay: a
    // wrong guess creates an account on the wrong server and cannot be migrated
    // by switching profiles afterwards.
    if (!planMode && assumeYesFlag && !relayNamedOnCommandLine) {
        const out = createOutputBuilder();
        out.line(warn('Setup needs you to choose a relay before it can continue.'));
        out.line(`Run ${cmd('happier setup')} in a terminal, or name the relay explicitly and pass ${cmd('--yes')}.`);
        console.log(out.render());
        process.exitCode = 1;
        return;
    }

    if (!planMode && !relayNamedOnCommandLine && !assumeYesFlag && isInteractiveTerminalFn()) {
        const readiness = await resolveActiveServerAuthReadiness({
            readCredentialsFn,
            readSettingsFn,
        }).catch(() => null);
        if (!readiness?.authenticated) {
            relayQuestionAsked = true;
            const selection = await askWhereTheRelayLives(promptInputFn);
            if (selection.kind === 'thisComputer') {
                installLocalRelay = true;
            } else if (selection.kind === 'existing') {
                existingRelayToAdd = selection.url;
            } else {
                // Cloud is a choice, not the absence of one. Skipping the selection
                // left a computer that already pointed at another relay — a
                // half-finished earlier setup, most likely — signing in there after
                // the user explicitly asked for Cloud.
                relayQuestionSelectionArgs = ['--server', 'cloud'];
            }
        }
    }

    // Confirmation is deliberately before relay installation or profile writes.
    // Choosing an answer previews intent; it is not itself consent to mutate.
    if (!planMode && !assumeYesFlag) {
        if (!isInteractiveTerminalFn()) {
            throw new Error('Non-interactive mode: pass --yes with an explicit relay to run deterministic setup steps.');
        }
        const confirm = (await promptInputFn('Run setup now? [Y/n] ')).trim().toLowerCase();
        if (confirm.startsWith('n')) {
            const out = createOutputBuilder();
            out.line('Aborted.');
            console.log(out.render());
            return;
        }
    }

    if (installLocalRelay) {
        // Setup owns the final background-service reconciliation. Letting the
        // child do it here restarts or prompts once during relay install and a
        // second time when setup reaches its service steps.
        const exitCode = await runHappyCliStepFn(
            ['relay', 'host', 'install'],
            { env: childEnvWithDeferredServerSelectionFollowUp() },
        );
        if (exitCode !== 0) {
            console.error(errorFrame('Error:', [`Setup step failed (exit ${exitCode}): happier relay host install`]));
            process.exitCode = exitCode;
            return;
        }
        reloadConfiguration();
        if (isLoopbackServerHost(configuration.serverUrl)) {
            await offerRelayAccessForLocalRelay({ promptInputFn, runHappyCliStepFn });
            // The relay-access command owns adopting an available share URL in
            // the active profile. Re-read that canonical result before auth so
            // mobile/web selection and QR links use the address it chose.
            reloadConfiguration();
        }
    }

    if (existingRelayToAdd) {
        const exitCode = await runHappyCliStepFn(
            [
                'server',
                'add',
                '--server-url',
                existingRelayToAdd,
                '--name',
                defaultNameFromUrl(existingRelayToAdd),
                '--use',
            ],
            { env: childEnvWithDeferredServerSelectionFollowUp() },
        );
        if (exitCode !== 0) {
            console.error(errorFrame('Error:', [`Setup step failed (exit ${exitCode}): happier server add`]));
            process.exitCode = exitCode;
            return;
        }
        reloadConfiguration();
    }

    let argsAfterServerSelection = stripSetupRelaySelectionArgs(argsForRun);
    // `setup plan` is a dry run, so it resolves the selection instead of applying it:
    // planning must never switch the active relay, persist a profile, or rewrite env.
    let plannedRelayUrl: string | null = null;
    if (
        relayQuestionSelectionArgs.length > 0
        || (explicitRelayUrl != null && !explicitRelayUrlMatchesCurrent)
        || hasRelaySelectionOverrides
    ) {
        const serverSelectionArgs = ensurePersistWhenServerUrlIsProvided(
            mapRelayUrlToServerSelectionArgs([...relayQuestionSelectionArgs, ...argsForRun]),
        );
        if (planMode) {
            const resolution = await resolveServerSelectionFromArgsFn(serverSelectionArgs);
            argsAfterServerSelection = [...resolution.rest];
            plannedRelayUrl = resolution.selection?.serverUrl ?? null;
        } else {
            argsAfterServerSelection = await applyServerSelectionFromArgsFn(serverSelectionArgs);
        }
    }

    const relayUrl = normalizeRelayUrl(explicitRelayUrl ?? plannedRelayUrl ?? configuration.serverUrl);
    const relaySelectionChanged = relayUrl !== currentRelayUrl;

    // The question exists to stop an account being created on the wrong relay, so
    // say which relay it is before `happier auth login` binds one to it.
    if (relayQuestionAsked) {
        const relayNotice = createOutputBuilder();
        relayNotice.blank();
        relayNotice.line(neutral(`Your account will live on ${relayUrl}.`));
        console.log(relayNotice.render());
    }

    const { present: skipDaemon, rest: withoutSkipDaemon } = takeFlag(argsAfterServerSelection, '--skip-daemon');
    const { present: skipProviders, rest: withoutSkipProviders } = takeFlag(withoutSkipDaemon, '--skip-providers');
    const { values: providers, rest: remaining } = takeRepeatedFlagValues(withoutSkipProviders, '--provider');
    const { present: yesFlag } = takeFlag(remaining, '--yes');

    const readiness = await resolveActiveServerAuthReadiness({
        readCredentialsFn,
        readSettingsFn,
    }).catch(() => null);
    const includeAuth = !readiness?.authenticated || !readiness.machineRegistered;

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
            await printJsonEnvelope({
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

    if (yesFlag && includeAuth) {
        const out = createOutputBuilder();
        out.line(warn('Setup needs you for the last step — signing in has to be approved on a device.'));
        out.blank();
        out.line(`  ${cmd('happier auth login')}`);
        console.log(out.render());
        process.exitCode = 1;
        return;
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
                // The installed service resolved its relay once, when it
                // started — before this run switched the machine. Reusing it
                // untouched leaves the daemon on the previous relay while setup
                // reports success against the new one.
                : relaySelectionChanged
                    ? [{
                        id: 'daemon_start',
                        argv: ['service', 'restart'],
                        display: 'happier service restart',
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
        const display = 'display' in step ? step.display : `happier ${step.argv.join(' ')}`;
        const exitCode = await runHappyCliStepFn(step.argv);
        if (exitCode !== 0) {
            console.error(errorFrame('Error:', [`Setup step failed (exit ${exitCode}): ${display}`]));
            process.exitCode = exitCode;
            return;
        }
    }

    const out = createOutputBuilder();
    out.line(ok('Setup complete.'));
    console.log(out.render());

    // Only when the user asked for no agent installs. Every other path just ran
    // `happier agents setup`, which fails loudly on a failed install and shows the
    // agent list when it asks — so a warning there would be either wrong or noise.
    if (skipProviders) {
        await warnWhenNoCodingAgentIsInstalled(listInstalledAgentIdsFn);
    }
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
