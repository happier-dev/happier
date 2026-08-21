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

import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import {
    resolveTailscaleInstallStrategy,
    type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import type { CommandContext } from '@/cli/commandRegistry';
import { readTailscaleStatusSnapshot } from '@/integrations/tailscale/tailscaleStatus';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { openBrowser } from '@/ui/openBrowser';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { defaultNameFromUrl } from './server/commandUtilities';
import { DEFER_SERVER_SELECTION_FOLLOW_UP_ENV } from './backgroundServiceFollowUp';
import {
    buildSetupPlan,
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

function describeTailscaleState(reachability: SetupRelayReachability): string {
    if (reachability.kind === 'tailnet') {
        return reachability.tailnetName
            ? `Tailscale is running on this computer (tailnet: ${reachability.tailnetName}).`
            : 'Tailscale is running on this computer.';
    }
    if (reachability.kind === 'tailscaleNotRunning') {
        return 'Tailscale is installed on this computer but is not running.';
    }
    return 'Tailscale is not installed on this computer.';
}

function printRelayReachabilityIntro(reachability: SetupRelayReachability): void {
    console.log('');
    console.log('The relay will run here, and your phone has to reach it over the network.');
    console.log(describeTailscaleState(reachability));
    if (reachability.kind === 'tailnet') {
        console.log('Once it is installed, one command publishes it on your tailnet.');
    } else if (reachability.kind === 'tailscaleNotRunning') {
        console.log('Nothing is behind your tailnet addresses until it is running.');
    } else {
        console.log('Without it, the relay stays on this computer unless you already have an HTTPS');
        console.log('address for it.');
    }
    console.log('');
}

/**
 * What is left to do, stated per Tailscale state.
 *
 * `relay host install` already settles which address the relay profile uses and
 * warns when that address is local-only. What it never says is anything about
 * Tailscale itself — above all that an installed-but-stopped Tailscale is why no
 * tailnet address was on offer. That is the gap this fills, so nothing here
 * restates or second-guesses the address the install chose.
 */
async function printRelayReachabilityNextSteps(reachability: SetupRelayReachability): Promise<void> {
    const relayUrl = await readActiveRelayUrl();

    console.log('');
    if (relayUrl && !isLoopbackServerHost(relayUrl)) {
        console.log(`This relay is ready at ${relayUrl}.`);
        console.log('');
        return;
    }

    console.log('This relay is reachable from this computer only.');
    if (reachability.kind === 'tailscaleNotRunning') {
        console.log('Tailscale is installed here but not running, so your tailnet addresses have');
        console.log('nothing behind them. Start it and re-run the install to publish this relay:');
        console.log('');
        console.log('  tailscale up');
        console.log('  happier relay host install');
        console.log('');
        return;
    }
    if (reachability.kind === 'tailnet') {
        console.log('Tailscale is running, but the relay was not published on it. Re-run the');
        console.log('canonical install command to retry or review the Tailscale result:');
        console.log('');
        console.log('  happier relay host install');
        console.log('');
        return;
    }
    console.log('If you already have an HTTPS address for it, point Happier at that:');
    console.log('');
    console.log('  happier server add --server-url https://relay.example.com --use');
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
        console.log('Skipped. Setup continues; you can do this any time.');
        return;
    }

    const strategy = resolveTailscaleInstallStrategy(process.platform);
    console.log('');
    if (strategy.kind === 'downloadAndLaunch') {
        console.log(`Opening ${strategy.docsUrl}`);
        const opened = await openBrowser(strategy.docsUrl);
        if (!opened) {
            console.log('Open that page to download and install Tailscale.');
        }
    } else {
        // There is no installer this CLI owns on this platform, and package
        // managers differ per distribution. The docs page beats pretending.
        console.log(`Install Tailscale for this platform: ${strategy.docsUrl}`);
    }

    console.log('');
    console.log('Then, once it is installed and signed in, let the relay installer publish');
    console.log('and select the address through the same checked path setup uses:');
    console.log('');
    console.log('  tailscale up');
    console.log('  happier relay host install');
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
 * The sign-in command for the relay this computer actually ended up on.
 *
 * Read after the relay steps rather than planned with them, because a relay
 * hosted here only settles its address during `relay host install`.
 *
 * A loopback relay makes the normal recommendation wrong rather than merely
 * inconvenient: terminal links deliberately strip an address no other device can
 * reach, so the phone that scans the QR code is left pointing at whichever relay
 * it already had. The web app served by this relay is on the same machine, so it
 * is the one route that can reach it — and it is the route setup asks for.
 */
async function resolveAuthLoginArgv(): Promise<readonly string[]> {
    const bounded = ['auth', 'login', '--wait-timeout', String(AUTH_WAIT_TIMEOUT_SECONDS)];
    const relayUrl = await readActiveRelayUrl();
    if (!relayUrl || !isLoopbackServerHost(relayUrl)) return bounded;

    console.log('');
    console.log('Your phone cannot reach this relay yet, so signing in from the Happier app is not');
    console.log("an option here. Signing in from this computer's browser instead.");
    console.log('');
    console.log('Once the relay has an address your phone can reach — `tailscale up`, then');
    console.log('`happier relay host install` — `happier auth login` offers both routes again.');
    console.log('');
    return [...bounded, '--method', 'web'];
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

async function askWhereTheRelayLives(): Promise<SetupRelaySelection> {
    // Wording reused from the client's own pre-auth screen so the terminal and
    // the app ask the same question the same way.
    const choice = await promptMultipleChoice(
        [
            '',
            'Where does your relay live?',
            '',
            'Your relay routes messages between your phone and your computers.',
            'Choose where it lives — you can change this later.',
            '',
            '  c) Happier Cloud            Hosted relay — easiest to start with',
            '  r) A relay I already run',
            '  t) On this computer',
            '',
            'Choose',
        ].join('\n'),
        [
            { id: 'cloud', keys: ['c', 'cloud', ''], short: 'C' },
            { id: 'existing', keys: ['r', 'relay'], short: 'r' },
            { id: 'thisComputer', keys: ['t', 'this'], short: 't' },
        ] as const,
        { defaultId: 'cloud', maxAttempts: 3 },
    );

    if (choice === 'cloud') return { kind: 'cloud' };
    if (choice === 'thisComputer') return { kind: 'thisComputer' };

    const url = (await promptInput('Relay URL: ')).trim();
    if (!url) throw new Error('A relay URL is required to continue. Re-run `happier setup` when you have it.');
    return { kind: 'existing', url };
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
            console.log(`This computer is already set up (relay: ${step.relayUrl}).`);
            console.log('Run `happier status` to check everything, or `happier` to start a session.');
            return true;
        case 'explainRelayReachability':
            printRelayReachabilityIntro(step.reachability);
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
            return (await runCliStep(await resolveAuthLoginArgv(), { unattended })) === 0;
        case 'warnNoAgent':
            console.log('');
            console.log('No coding agent found on this computer.');
            console.log('');
            console.log("Happier drives your coding agent; it does not ship one. Install at least");
            console.log('one, then run `happier` again:');
            console.log('');
            console.log('  Claude Code   curl -fsSL https://claude.ai/install.sh | bash');
            console.log('  Codex         happier install provider codex');
            console.log('  OpenCode      happier install provider opencode');
            console.log('');
            console.log('  See them all: happier install provider --help');
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
        console.error(parsed.message);
        console.error('Run `happier setup --help` to see the options.');
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

    // Probed only for a relay we are about to host here, and only once: nothing
    // else in this flow depends on Tailscale.
    let tailscaleProbe: Promise<TailscaleStatusSnapshot | null> | null = null;
    const tailscaleFor = async (selection: SetupRelaySelection | null): Promise<TailscaleStatusSnapshot | null> => {
        if (selection?.kind !== 'thisComputer') return null;
        tailscaleProbe ??= readTailscaleStatusSnapshot();
        return await tailscaleProbe;
    };

    const planFor = async (selection: SetupRelaySelection | null) => buildSetupPlan({
        autonomy,
        auth: { authenticated: auth.authenticated, machineRegistered: auth.machineRegistered },
        activeRelayUrl: activeProfile?.serverUrl ?? null,
        relaySelection: selection,
        installedAgentIds,
        tailscale: await tailscaleFor(selection),
    });

    let plan = await planFor(relaySelection);

    // The one question setup owns. A plan that stops has already said why, so
    // asking here would be asking someone who is not there.
    if (!relaySelection && !plan.stop && plan.steps.length === 0) {
        relaySelection = await askWhereTheRelayLives();
        plan = await planFor(relaySelection);
    }

    for (const step of plan.steps) {
        const ok = await runStep(step, unattended);
        if (!ok) {
            console.log('');
            console.log('Setup stopped. Nothing was lost — run `happier setup` again to pick up where you left off,');
            console.log('or `happier status` to see what is configured.');
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
    }
}
