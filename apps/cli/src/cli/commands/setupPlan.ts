/**
 * The decision half of `happier setup`, kept pure so every branch is testable
 * without a terminal.
 *
 * Setup asks one question the client cannot answer for itself — where the relay
 * lives — because credentials are stored per relay profile and the answer has to
 * be settled before signing in. Everything after that delegates to commands that
 * already exist (`happier server add`, `happier auth login`, `happier relay host
 * install`); this module only decides which of them to run, in what order.
 */

import type { TailscaleStatusSnapshot } from '@happier-dev/cli-common/tailscale';

export type SetupRelaySelection =
  | Readonly<{ kind: 'cloud' }>
  | Readonly<{ kind: 'existing'; url: string }>
  | Readonly<{ kind: 'thisComputer' }>;

/**
 * How a phone will be able to reach a relay hosted on this computer.
 *
 * A relay the user's phone cannot reach is the worst outcome of setup, because
 * it is only discovered later and from somewhere else. Setup states the answer
 * before and after installing rather than leaving it to be found out.
 */
export type SetupRelayReachability =
  | Readonly<{ kind: 'tailnet'; tailnetName: string | null }>
  | Readonly<{ kind: 'tailscaleNotRunning' }>
  | Readonly<{ kind: 'tailscaleNotInstalled' }>;

export type SetupStep =
  | Readonly<{ kind: 'alreadyConfigured'; relayUrl: string }>
  | Readonly<{ kind: 'explainRelayReachability'; reachability: SetupRelayReachability }>
  | Readonly<{ kind: 'installLocalRelay' }>
  | Readonly<{ kind: 'selectRelay'; relayUrl: string }>
  | Readonly<{ kind: 'selectCloudRelay' }>
  | Readonly<{ kind: 'reportRelayReachability'; reachability: SetupRelayReachability }>
  | Readonly<{ kind: 'offerTailscaleSetup' }>
  | Readonly<{ kind: 'authLogin' }>
  | Readonly<{ kind: 'warnNoAgent' }>;

/**
 * How much of setup may run without someone watching.
 *
 * `--yes` and "there is no terminal" used to be the same boolean, and that is
 * why `--yes` refused to do anything at all. They ask for opposite things:
 *
 * - `interactive` — a person is here. Ask the questions setup owns.
 * - `unattended` — `--yes`. Nobody is watching, but they asked for the work.
 *   Run every step that needs no answer and stop at the one that does.
 * - `createNothing` — `--non-interactive`, `HAPPIER_NONINTERACTIVE=1`, or no
 *   terminal at all. Say what would be needed and write nothing.
 */
export type SetupAutonomy = 'interactive' | 'unattended' | 'createNothing';

/**
 * Where setup stops, and why.
 *
 * `needs-sign-in` is not a failure: the steps before it ran. Pairing has to be
 * approved on a phone or in a browser, so it is the one step no flag can
 * authorise on the user's behalf.
 */
export type SetupStopReason = 'needs-interactive' | 'needs-relay-choice' | 'needs-sign-in';

export type SetupStop = Readonly<{
  reason: SetupStopReason;
  detail: string;
}>;

/**
 * Whether this computer's stored sign-in is actually usable, as decided by the
 * auth owner rather than by the presence of a credentials file.
 *
 * Both halves matter and both were missing. Credential bytes the relay rejects
 * are why the installer hands off to setup at all, and credentials without a
 * registered machine leave every remote-control path dead — so answering
 * "already configured" from bytes alone hides exactly the two states setup
 * exists to repair.
 */
export type SetupAuthReadiness = Readonly<{
  /** Credentials exist and the active relay did not reject them. */
  authenticated: boolean;
  /** A machine identity is registered for the active relay. */
  machineRegistered: boolean;
}>;

export type SetupPlan = Readonly<{
  steps: readonly SetupStep[];
  /** Null when the plan runs to completion. */
  stop: SetupStop | null;
}>;

export type BuildSetupPlanParams = Readonly<{
  /** How much may run without a person watching. */
  autonomy: SetupAutonomy;
  /** Resolved by the auth owner, never re-derived from stored bytes here. */
  auth: SetupAuthReadiness;
  /** The relay the CLI is currently pointed at, if any. */
  activeRelayUrl: string | null;
  /** What the user chose, or null when the choice has not been made yet. */
  relaySelection: SetupRelaySelection | null;
  /** Agent CLIs actually resolvable on this machine. */
  installedAgentIds: readonly string[];
  /**
   * `tailscale status` for this machine, or null when the Tailscale CLI is not
   * installed here. Only consulted for a relay hosted on this computer.
   */
  tailscale: TailscaleStatusSnapshot | null;
}>;

/**
 * What the command line asked for, or why it cannot be honoured.
 *
 * Parsing is a decision like any other in this module, and it was the loosest
 * one: `--cloud --relay <url>` silently kept the relay, and a misspelled
 * `--this-computer` was silently ignored, which is how a typo could end in a
 * Cloud account nobody asked for. Both are refused rather than guessed.
 */
export type SetupArgs =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'invalid'; message: string }>
  | Readonly<{
      kind: 'run';
      relaySelection: SetupRelaySelection | null;
      /** `--yes`: run every step that needs no answer. */
      assumeYes: boolean;
      /** `--non-interactive`: change nothing. */
      forcedNonInteractive: boolean;
    }>;

const RELAY_CHOICE_FLAGS = ['--cloud', '--relay', '--this-computer'] as const;
const KNOWN_FLAGS: readonly string[] = [...RELAY_CHOICE_FLAGS, '--yes', '--non-interactive', '-h', '--help'];

export function parseSetupArgs(args: readonly string[]): SetupArgs {
  if (args.includes('-h') || args.includes('--help')) return { kind: 'help' };

  let relaySelection: SetupRelaySelection | null = null;
  let chosenFlag: string | null = null;
  let assumeYes = false;
  let forcedNonInteractive = false;

  const choose = (flag: string, selection: SetupRelaySelection): SetupArgs | null => {
    if (chosenFlag && chosenFlag !== flag) {
      return {
        kind: 'invalid',
        message: `Choose one relay: ${chosenFlag} and ${flag} cannot both be given.`,
      };
    }
    if (chosenFlag === flag) {
      return { kind: 'invalid', message: `${flag} was given twice.` };
    }
    chosenFlag = flag;
    relaySelection = selection;
    return null;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--yes') {
      assumeYes = true;
      continue;
    }
    if (arg === '--non-interactive') {
      forcedNonInteractive = true;
      continue;
    }
    if (arg === '--cloud') {
      const conflict = choose(arg, { kind: 'cloud' });
      if (conflict) return conflict;
      continue;
    }
    if (arg === '--this-computer') {
      const conflict = choose(arg, { kind: 'thisComputer' });
      if (conflict) return conflict;
      continue;
    }
    if (arg === '--relay') {
      const value = String(args[index + 1] ?? '').trim();
      if (!value || value.startsWith('-')) {
        return { kind: 'invalid', message: '--relay needs a relay URL, for example `--relay https://relay.example.com`.' };
      }
      const conflict = choose(arg, { kind: 'existing', url: value });
      if (conflict) return conflict;
      index += 1;
      continue;
    }
    return {
      kind: 'invalid',
      message: `Unknown option: ${arg}. Known options: ${KNOWN_FLAGS.join(', ')}.`,
    };
  }

  if (assumeYes && forcedNonInteractive) {
    // They were one flag until `--yes` learned to do the work. Now `--yes` says
    // "run the steps that need no answer" and `--non-interactive` says "change
    // nothing"; guessing which one they meant is how setup would either stall or
    // write state nobody asked for.
    return {
      kind: 'invalid',
      message: 'Choose one: --yes runs every step that needs no answer, --non-interactive changes nothing.',
    };
  }

  return { kind: 'run', relaySelection, assumeYes, forcedNonInteractive };
}

/**
 * Reachability follows `running`, never `loggedIn`.
 *
 * `tailscale down` keeps the node key, the tailnet name and the tailnet IPs, so
 * a stopped backend still reports `loggedIn: true` with addresses nothing is
 * listening on. A daemon that never answered reports neither, but it is still
 * an installed Tailscale that has to be started — not a missing one.
 */
function classifyRelayReachability(
  tailscale: TailscaleStatusSnapshot | null,
): SetupRelayReachability {
  if (!tailscale) return { kind: 'tailscaleNotInstalled' };
  if (!tailscale.running) return { kind: 'tailscaleNotRunning' };
  return { kind: 'tailnet', tailnetName: tailscale.tailnetName };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

/**
 * What an unattended run has to say when it will not choose a relay.
 *
 * `--yes` means "accept the recommended defaults", and there is no recommended
 * answer to "where does your relay live?" — the account lives on whichever relay
 * is picked. Guessing Cloud would create an account on a service the user never
 * named.
 */
const RELAY_CHOICE_REQUIRED = [
  'Setup will not choose a relay for you — your account lives on the one you pick.',
  'Name it:',
  '',
  '  happier setup --cloud --yes',
  '  happier setup --relay https://relay.example.com --yes',
  '  happier setup --this-computer --yes',
].join('\n');

/**
 * The wall every unattended run reaches.
 *
 * Pairing is approved on a phone or in a browser by a person, so `auth login`
 * is the one step no flag can stand in for. Everything before it has already
 * run by the time this is printed.
 */
const SIGN_IN_REQUIRED = [
  'Setup needs you for the last step — signing in has to be approved on a device.',
  '',
  '  happier auth login',
].join('\n');

export function buildSetupPlan(params: BuildSetupPlanParams): SetupPlan {
  const activeRelayUrl = params.activeRelayUrl ? normalizeUrl(params.activeRelayUrl) : null;
  const configured = params.auth.authenticated && params.auth.machineRegistered && Boolean(activeRelayUrl);
  const selection = params.relaySelection;

  // Nothing to do: this machine already has credentials against a relay and the
  // user has not asked to move to a different one.
  if (configured && !selection) {
    return { steps: [{ kind: 'alreadyConfigured', relayUrl: activeRelayUrl! }], stop: null };
  }

  // A valid account already settles the relay choice. A missing machine ID is
  // repaired by the same auth/pairing owner, not by asking the user to choose
  // where their existing account lives a second time.
  if (!selection && params.auth.authenticated && activeRelayUrl) {
    if (params.autonomy === 'createNothing') {
      return {
        steps: [],
        stop: {
          reason: 'needs-interactive',
          detail: 'This account is already selected, but this computer still needs to be registered. Run `happier auth login` in a terminal to finish.',
        },
      };
    }

    const steps: SetupStep[] = params.autonomy === 'interactive'
      ? [{ kind: 'authLogin' }]
      : [];
    if (params.installedAgentIds.length === 0) {
      steps.push({ kind: 'warnNoAgent' });
    }
    return {
      steps,
      stop: params.autonomy === 'interactive'
        ? null
        : { reason: 'needs-sign-in', detail: SIGN_IN_REQUIRED },
    };
  }

  if (params.autonomy === 'createNothing') {
    // Nobody is here at all: no flag on this command line said "go ahead".
    // Whatever was named, writing a relay profile or starting an install would
    // be state the user never watched being created.
    return {
      steps: [],
      stop: {
        reason: 'needs-interactive',
        detail: selection
          ? 'Setup changes nothing unattended unless you ask it to. Run `happier setup --yes` to do the '
            + 'steps that need no answer, then `happier auth login` to finish — signing in has to be '
            + 'approved on your phone or in a browser.'
          : 'Setup needs a terminal to ask where your relay lives. Run `happier setup` directly, or name '
            + 'the relay yourself: `happier setup --cloud --yes`.',
      },
    };
  }

  if (!selection) {
    return params.autonomy === 'unattended'
      ? { steps: [], stop: { reason: 'needs-relay-choice', detail: RELAY_CHOICE_REQUIRED } }
      : { steps: [], stop: null };
  }

  const interactive = params.autonomy === 'interactive';
  const steps: SetupStep[] = [];

  if (selection.kind === 'thisComputer') {
    const reachability = classifyRelayReachability(params.tailscale);
    steps.push({ kind: 'explainRelayReachability', reachability });
    steps.push({ kind: 'installLocalRelay' });
    steps.push({ kind: 'reportRelayReachability', reachability });
    // Opt-in, and only where there is something to install: a stopped Tailscale
    // needs starting, not installing. Installing a VPN is a question, so an
    // unattended run never gets to ask it.
    if (interactive && reachability.kind === 'tailscaleNotInstalled') {
      steps.push({ kind: 'offerTailscaleSetup' });
    }
  } else if (selection.kind === 'existing') {
    steps.push({ kind: 'selectRelay', relayUrl: normalizeUrl(selection.url) });
  } else if (activeRelayUrl) {
    // Cloud is a choice, not the absence of one. Skipping the step left a
    // machine that already points at a custom relay — a half-finished earlier
    // setup, most likely — authenticating against that relay after the user
    // explicitly asked for Cloud.
    steps.push({ kind: 'selectCloudRelay' });
  }

  // The only step that cannot be run for someone. An unattended run does
  // everything up to here and then names it.
  if (interactive) {
    steps.push({ kind: 'authLogin' });
  }

  if (params.installedAgentIds.length === 0) {
    // Never blocking: the user can finish setup and install an agent after.
    steps.push({ kind: 'warnNoAgent' });
  }

  return {
    steps,
    stop: interactive ? null : { reason: 'needs-sign-in', detail: SIGN_IN_REQUIRED },
  };
}
