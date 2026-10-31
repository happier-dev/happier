/**
 * `happier setup` — the guided first run.
 *
 * Fresh interactive installs hand off here after the binary is ready. This asks
 * the one question the client cannot answer for itself: where the relay lives.
 * Everything else delegates to commands that already exist.
 *
 * The decision logic lives in `./setupPlan` so it can be tested without a
 * terminal; this file owns prompting and delegation only.
 */

import { hostname } from 'node:os';

import {
    AGENT_IDS,
    AGENTS_CORE,
    DEFAULT_AGENT_ID,
    getProviderCliRuntimeSpec,
    type AgentId,
} from '@happier-dev/agents';
import {
    cmd,
    createSetupChoicePrompt,
    createStepPrinter,
    definitionList,
    errorFrame,
    gray,
    info,
    neutral,
    ok,
    renderSetupWelcome,
    sectionTitle,
    warn,
} from '@happier-dev/cli-common/output';
import {
    resolveTailscaleInstallStrategy,
    type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import type { CommandContext } from '@/cli/commandRegistry';
import { readTailscaleStatusSnapshot } from '@/integrations/tailscale/tailscaleStatus';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { invokeProviderCliInstall } from '@/runtime/managedTools/invokeProviderCliInstall';
import { runProviderCliInstallStep } from '@/runtime/managedTools/providerCliInstallStep';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { promptMultipleSelection } from '@/terminal/prompts/promptMultipleChoice';
import { openBrowser } from '@/ui/openBrowser';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { defaultNameFromUrl } from './server/commandUtilities';
import { DEFER_SERVER_SELECTION_FOLLOW_UP_ENV } from './backgroundServiceFollowUp';
import {
    buildSetupPlan,
    describeHostOnThisComputerChoice,
    parseSetupArgs,
    type SetupAutonomy,
    type SetupRelayReachability,
    type SetupRelaySelection,
    type SetupStep,
} from './setupPlan';

/**
 * What setup hands its children when nobody is watching.
 *
 * `isInteractiveTerminal()` answers from the controlling terminal, and a script
 * that runs `happier setup --yes` from a shell still has one — so a child left
 * to decide for itself will happily prompt for a relay profile name nobody is
 * going to type. `HAPPIER_NONINTERACTIVE=1` is the signal the installers
 * already use to mean exactly this, and the CLI's one reader of it is
 * `isInteractiveTerminal()`, so setting it here settles every child at once.
 */
const UNATTENDED_CHILD_ENV: NodeJS.ProcessEnv = { HAPPIER_NONINTERACTIVE: '1' };

const HELP = `happier setup — connect this computer to your Happier account

Usage:
  happier setup [options]

Options:
  --cloud                 Use Happier Cloud without being asked
  --relay <url>           Use a relay you already run
  --this-computer         Install and use a relay on this computer
  --yes                   Ask nothing. Every step that needs no answer runs, then
                          setup stops at signing in, which has to be approved on
                          your phone or in a browser, and names the command that
                          finishes it. Needs one of --cloud/--relay/--this-computer:
                          setup never picks a relay for you. Exits non-zero,
                          because setup is unfinished until you sign in.
  --non-interactive       Change nothing. Setup says what it would need and exits
                          non-zero. Also how setup reads HAPPIER_NONINTERACTIVE=1
                          and a run with no terminal at all.
  -h, --help              Show this help

Setup asks where your relay lives, points this computer at it, and signs you in.
Your account lives on the relay you choose, so this is settled before sign-in.
`;

async function listInstalledAgentIds(): Promise<AgentId[]> {
    const installed: AgentId[] = [];
    for (const agentId of AGENT_IDS) {
        // `customAcp` is a family, not an installable CLI.
        if (agentId === 'customAcp') continue;
        try {
            if (resolveProviderCliCommand(agentId, {})) installed.push(agentId);
        } catch {
            // A resolver failure means "not usable here", which is what we asked.
        }
    }
    return installed;
}

async function readActiveRelayUrl(): Promise<string | null> {
    const profile = await getActiveServerProfile().catch(() => null);
    const url = String(profile?.serverUrl ?? '').trim();
    return url || null;
}

/**
 * What is left to do, stated per Tailscale state.
 *
 * `relay host install` already settles which address the relay profile uses and
 * warns when that address is local-only. What it never says is anything about
 * Tailscale itself — especially that an installed-but-stopped Tailscale is why no
 * tailnet address was on offer. That is the gap this fills, so nothing here
 * restates or second-guesses the address the install chose.
 */
async function printRelayReachabilityNextSteps(reachability: SetupRelayReachability): Promise<void> {
    const relayUrl = await readActiveRelayUrl();

    console.log('');
    if (relayUrl && !isLoopbackServerHost(relayUrl)) {
        console.log(ok(`This relay is ready at ${relayUrl}.`));
        console.log('');
        return;
    }

    console.log(warn('This relay is reachable from this computer only.'));
    if (reachability.kind === 'tailscaleNotRunning') {
        console.log(gray('  Tailscale is installed here but not running, so your tailnet addresses have'));
        console.log(gray('  nothing behind them. Start it and re-run the install to publish this relay:'));
        console.log('');
        console.log(`    ${cmd('tailscale up')}`);
        console.log(`    ${cmd('happier relay host install')}`);
        console.log('');
        return;
    }
    if (reachability.kind === 'tailnet') {
        console.log(gray('  Tailscale is running, but the relay was not published on it. Re-run the'));
        console.log(gray('  canonical install command to retry or review the Tailscale result:'));
        console.log('');
        console.log(`    ${cmd('happier relay host install')}`);
        console.log('');
        return;
    }
    console.log(gray('  If you already have an HTTPS address for it, point Happier at that:'));
    console.log('');
    console.log(`    ${cmd('happier server add --server-url https://relay.example.com --use')}`);
    console.log('');
}

/**
 * Offer, never assume. Installing a VPN on someone's machine is not a detail to
 * slip into a setup flow, so the default is "no".
 */
async function offerTailscaleSetup(): Promise<void> {
    const wanted = await promptConfirmYesNo(
        'Set up Tailscale now? It gives this computer a private address your phone can reach.',
        { default: 'no' },
    );
    if (!wanted) {
        console.log(neutral('Skipped. Setup continues; you can do this any time.'));
        return;
    }

    const strategy = resolveTailscaleInstallStrategy(process.platform);
    console.log('');
    if (strategy.kind === 'downloadAndLaunch') {
        console.log(info(`Opening ${strategy.docsUrl}`));
        const opened = await openBrowser(strategy.docsUrl);
        if (!opened) {
            console.log(gray('  Open that page to download and install Tailscale.'));
        }
    } else {
        // There is no installer this CLI owns on this platform, and package
        // managers differ per distribution. The docs page beats pretending.
        console.log(info(`Install Tailscale for this platform: ${strategy.docsUrl}`));
    }

    console.log('');
    console.log(gray('Then, once it is installed and signed in, let the relay installer publish'));
    console.log(gray('and select the address through the same checked path setup uses:'));
    console.log('');
    console.log(`    ${cmd('tailscale up')}`);
    console.log(`    ${cmd('happier relay host install')}`);
    console.log('');
}

/**
 * How long setup waits for the sign-in to be approved before handing the
 * terminal back.
 *
 * Long enough to unlock a phone, open the app and approve; short enough that a
 * browser that never opened does not leave an installer-invoked setup holding a
 * terminal nobody is watching. `auth login` owns the wait and prints how to
 * finish it — setup only says how long it is prepared to block.
 */
const AUTH_WAIT_TIMEOUT_SECONDS = 300;

/**
 * Setup bounds how long its child may occupy the terminal. Authentication owns
 * method selection because only it knows whether this invocation creates a new
 * request or merely repairs machine registration from an existing credential.
 */
function resolveAuthLoginArgv(): readonly string[] {
    return ['auth', 'login', '--wait-timeout', String(AUTH_WAIT_TIMEOUT_SECONDS), '--no-daemon-start'];
}

async function runCliStep(
    args: readonly string[],
    params: Readonly<{ unattended: boolean; deferServerSelectionFollowUp?: boolean }>,
): Promise<number> {
    return await new Promise<number>((resolve) => {
        const extraEnv: NodeJS.ProcessEnv = {
            ...(params.unattended ? UNATTENDED_CHILD_ENV : {}),
            ...(params.deferServerSelectionFollowUp ? { [DEFER_SERVER_SELECTION_FOLLOW_UP_ENV]: '1' } : {}),
        };
        const child = spawnHappyCLI([...args], {
            stdio: 'inherit',
            ...(Object.keys(extraEnv).length > 0 ? { env: { ...process.env, ...extraEnv } } : {}),
        });
        child.on('error', () => resolve(1));
        child.on('exit', (code) => resolve(typeof code === 'number' ? code : 1));
    });
}

async function askWhereTheRelayLives(tailscale: TailscaleStatusSnapshot | null): Promise<SetupRelaySelection> {
    const setupChoicePrompt = createSetupChoicePrompt({
        machineName: hostname(),
        subtitle: 'Connect your devices. Your coding agents run here.',
        question: 'How would you like to connect your devices?',
        choices: [
            { id: 'cloud', key: 'c', label: 'Happier Cloud (recommended)', description: 'No server maintenance', isDefault: true },
            { id: 'existing', key: 'r', label: 'Existing server', description: 'Address from the Happier app or your administrator' },
            { id: 'thisComputer', key: 't', label: 'Host on this computer', description: describeHostOnThisComputerChoice(tailscale) },
        ],
    });
    const choice = await promptMultipleChoice(
        setupChoicePrompt.message,
        [
            { id: 'cloud', keys: ['c', 'cloud', ''], short: 'C' },
            { id: 'existing', keys: ['r', 'relay'], short: 'r' },
            { id: 'thisComputer', keys: ['t', 'this'], short: 't' },
        ] as const,
        {
            defaultId: 'cloud',
            maxAttempts: 3,
            ...(setupChoicePrompt.renderMessage
                ? {
                    animate: setupChoicePrompt.animate === true,
                    renderMessage: setupChoicePrompt.renderMessage,
                    ...(setupChoicePrompt.intervalMs === undefined ? {} : { intervalMs: setupChoicePrompt.intervalMs }),
                }
                : {}),
        },
    );

    if (choice === 'cloud') return { kind: 'cloud' };
    if (choice === 'thisComputer') return { kind: 'thisComputer' };

    const url = (await promptInput('Server address from the Happier app or your administrator: ')).trim();
    if (!url) throw new Error('A server address is required to continue. Re-run `happier setup` when you have it.');
    return { kind: 'existing', url };
}

function listInstallableAgentIds(): AgentId[] {
    return AGENT_IDS.filter((agentId) => getProviderCliRuntimeSpec(agentId).manualInstallKind !== 'none');
}

async function offerCodingAgentSetup(installedAgentIds: readonly string[]): Promise<boolean> {
    const installed = new Set(installedAgentIds);
    const missing = listInstallableAgentIds().filter((agentId) => !installed.has(agentId));
    if (missing.length === 0) return true;
    const selected = await promptMultipleSelection<AgentId>(
        'Choose coding agents to install.',
        [
            ...missing.map((agentId) => {
                const runtimeSpec = getProviderCliRuntimeSpec(agentId);
                return {
                    id: agentId,
                    label: `${runtimeSpec.title} (${agentId})`,
                    description: runtimeSpec.managedInstall
                        ? 'Happier-managed install'
                        : runtimeSpec.manualInstallKind === 'vendor_recipe'
                            ? 'Runs the agent vendor installer'
                            : 'Uses the catalog install command',
                    selected: agentId === DEFAULT_AGENT_ID,
                };
            }),
            { id: 'skip', label: 'Skip for now', kind: 'skip' as const },
        ],
    );
    if (selected.length === 0) return true;

    let allOk = true;
    // Each install is a visible step: it can take a while, and it ends as ✓ with how long it took.
    const steps = createStepPrinter();
    for (const agentId of selected) {
        const spec = getProviderCliRuntimeSpec(agentId);
        const result = await runProviderCliInstallStep(steps, spec.title, () => invokeProviderCliInstall({ agentId }));
        if (!result.ok) {
            allOk = false;
            console.error(gray(`  Could not install ${spec.title}: ${result.errorMessage}`));
            if (result.logPath) console.error(gray(`  Install log: ${result.logPath}`));
            continue;
        }
        const resolved = (() => {
            try {
                return resolveProviderCliCommand(agentId, {}) !== null;
            } catch {
                return false;
            }
        })();
        if (!resolved) {
            allOk = false;
            console.error(warn(`${spec.title} is installed, but it is not resolvable yet`));
            console.error(gray(`  Open a new shell or run ${cmd('happier status')}, then retry.`));
        }
    }
    return allOk;
}

function printSetupAgentReadiness(installedAgentIds: readonly AgentId[]): void {
    if (installedAgentIds.length === 0) {
        console.log('');
        console.log(warn('This computer is connected, but you still need a coding agent before starting a session.'));
        console.log(gray('  Install one in the app: Settings → Agents → CLI & Authentication.'));
        console.log(gray(`  Or run ${cmd('happier setup')} again from this terminal.`));
        return;
    }
    const cliSubcommand = AGENTS_CORE[installedAgentIds[0]!].cliSubcommand;
    console.log('');
    console.log(ok('Computer connected. Coding agent installed.'));
    console.log('');
    console.log(sectionTitle('Start your first session'));
    console.log(definitionList([
        { label: 'App', value: 'New session → this computer → choose a project' },
        { label: 'CLI', value: cmd(`happier ${cliSubcommand}`) },
    ], { indent: '  ' }));
    console.log(gray('Agent installation and sign-in are separate. Manage both in the app:'));
    console.log(gray('  Settings → Agents → CLI & Authentication'));
}

/**
 * `server add` asks for a relay profile name whenever it can, and refuses to run
 * without `--name` the moment it cannot. Either way an unattended run has to
 * supply one, so it supplies the same default `server add` would have offered.
 */
function serverAddArgs(relayUrl: string): readonly string[] {
    return ['server', 'add', '--server-url', relayUrl, '--name', defaultNameFromUrl(relayUrl), '--use'];
}

async function runStep(step: SetupStep, unattended: boolean): Promise<boolean> {
    switch (step.kind) {
        case 'alreadyConfigured':
            console.log(ok(`This computer is already connected (relay: ${step.relayUrl}).`));
            return true;
        case 'installLocalRelay':
            return (await runCliStep(['relay', 'host', 'install'], {
                unattended,
                deferServerSelectionFollowUp: true,
            })) === 0;
        case 'reportRelayReachability':
            await printRelayReachabilityNextSteps(step.reachability);
            return true;
        case 'offerTailscaleSetup':
            await offerTailscaleSetup();
            return true;
        case 'selectRelay': {
            return (await runCliStep(serverAddArgs(step.relayUrl), {
                unattended,
                deferServerSelectionFollowUp: true,
            })) === 0;
        }
        case 'selectCloudRelay':
            return (await runCliStep(['server', 'use', 'cloud'], {
                unattended,
                deferServerSelectionFollowUp: true,
            })) === 0;
        case 'authLogin':
            return (await runCliStep(resolveAuthLoginArgv(), { unattended })) === 0;
        case 'setupAgents':
            return await offerCodingAgentSetup(step.installedAgentIds);
        case 'warnNoAgent':
            console.log('');
            console.log(warn('No coding agent found on this computer.'));
            console.log(gray(`  Happier drives your coding agent; it does not ship one. Install at least one, then run ${cmd('happier')} again:`));
            console.log('');
            console.log(definitionList(listInstallableAgentIds().slice(0, 3).map((agentId) => ({
                label: getProviderCliRuntimeSpec(agentId).title,
                value: cmd(`happier install provider ${agentId}`),
            })), { indent: '  ' }));
            console.log('');
            console.log(definitionList([
                { label: 'App', value: 'Settings → Agents → CLI & Authentication' },
                { label: 'CLI', value: cmd('happier install provider --help') },
            ], { indent: '  ' }));
            return true;
        default:
            return true;
    }
}

export async function handleSetupCliCommand(context: CommandContext): Promise<void> {
    const parsed = parseSetupArgs(context.args.slice(1));

    if (parsed.kind === 'help') {
        console.log(HELP);
        return;
    }

    if (parsed.kind === 'invalid') {
        // Silently ignoring an unknown or contradictory flag is how a misspelled
        // `--this-computer` became a Cloud account nobody asked for.
        console.error(errorFrame(parsed.message, [`Run ${cmd('happier setup --help')} to see the options.`]));
        process.exitCode = 1;
        return;
    }

    // `--yes` is an explicit instruction to go ahead, so it outranks both the
    // ambient HAPPIER_NONINTERACTIVE=1 and a missing terminal — which is the
    // whole point of running setup from a script. `isInteractiveTerminal()` is
    // the CLI's one reader of that environment variable; setup does not keep a
    // second copy of the rule.
    const autonomy: SetupAutonomy = parsed.assumeYes
        ? 'unattended'
        : parsed.forcedNonInteractive || !isInteractiveTerminal()
            ? 'createNothing'
            : 'interactive';
    const unattended = autonomy === 'unattended';

    const [auth, activeProfile, installedAgentIds] = await Promise.all([
        // Readiness is the auth owner's to decide. Stored credential bytes say
        // nothing about whether the relay still accepts them or whether this
        // machine was ever registered — the two states setup exists to repair.
        resolveActiveServerAuthReadiness(),
        getActiveServerProfile().catch(() => null),
        listInstalledAgentIds(),
    ]);

    let relaySelection = parsed.relaySelection;

    // Probed at most once, and only when a relay may be hosted here: for that
    // relay's reachability, or to describe the choice of hosting one.
    let tailscaleProbe: Promise<TailscaleStatusSnapshot | null> | null = null;
    const probeTailscale = (): Promise<TailscaleStatusSnapshot | null> => {
        tailscaleProbe ??= readTailscaleStatusSnapshot();
        return tailscaleProbe;
    };
    const tailscaleFor = async (selection: SetupRelaySelection | null): Promise<TailscaleStatusSnapshot | null> => {
        if (selection?.kind !== 'thisComputer') return null;
        return await probeTailscale();
    };

    const planFor = async (selection: SetupRelaySelection | null) => buildSetupPlan({
        autonomy,
        auth: {
            authenticated: auth.authenticated,
            credentialState: auth.credentialState,
            machineRegistered: auth.machineRegistered,
        },
        activeRelayUrl: activeProfile?.serverUrl ?? null,
        relaySelection: selection,
        installedAgentIds,
        tailscale: await tailscaleFor(selection),
    });

    let plan = await planFor(relaySelection);

    const needsRelayChoice = !relaySelection && !plan.stop && plan.steps.length === 0;
    if (autonomy === 'interactive' && !needsRelayChoice && !plan.steps.some((step) => step.kind === 'alreadyConfigured')) {
        console.log(renderSetupWelcome({
            machineName: hostname(),
            subtitle: 'Connect your devices. Your coding agents run here.',
        }));
    }

    // The one question setup owns. A plan that stops has already said why, so
    // asking here would be asking someone who is not there.
    if (needsRelayChoice) {
        relaySelection = await askWhereTheRelayLives(await probeTailscale());
        plan = await planFor(relaySelection);
    }

    for (const step of plan.steps) {
        const ok = await runStep(step, unattended);
        if (!ok) {
            console.log('');
            console.log(warn('Setup stopped. Nothing was lost.'));
            console.log(gray(`  Run ${cmd('happier setup')} again to pick up where you left off, or ${cmd('happier status')} to see what is configured.`));
            // Exit non-zero so the installer reports setup as incomplete rather
            // than printing "you're ready". Installing the binary still
            // succeeded; finishing the guided setup did not.
            process.exitCode = 1;
            return;
        }
    }

    if (plan.stop) {
        if (plan.steps.length > 0) console.log('');
        console.log(plan.stop.detail);
        // Setup is unfinished either way — nothing was created, or the sign-in
        // that finishes it still has to be approved by a person. The installer
        // reads a zero exit as "you're ready".
        process.exitCode = 1;
        return;
    }

    printSetupAgentReadiness(await listInstalledAgentIds());
}
