import type {
    MachineAgent,
    MachineAgentSignInSession,
} from '@/agents/machineAgents/machineAgentTypes';
import type { AgentInstallJobFailurePresentationInput } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

/** A reported installer failure or the presentation owner's uncertainty fallback. */
export type MachineAgentJobFailure = AgentInstallJobFailurePresentationInput;

const UNKNOWN_FAILURE: MachineAgentJobFailure = { kind: 'failed', code: 'unknown', stepId: null, message: null };

/**
 * How one agent on one machine reads on every surface (lab `agent-setup`): which phase of the setup
 * form it is in, the one status line of its row or card, and the one action next to it. Pure: it maps
 * the inventory model (`MachineAgent`, decided by its owner) plus the shared sign-in session to
 * presentation; it never decides installed / signed in itself.
 */

export type AgentSetupPhase =
    | 'install'
    | 'manualInstall'
    | 'installing'
    | 'installFailed'
    | 'unsupported'
    | 'signIn'
    | 'waitingForSignIn'
    | 'ready'
    | 'checking'
    | 'unknown';

export type MachineAgentRowAction =
    | Readonly<{ kind: 'install' }>
    | Readonly<{ kind: 'update' }>
    | Readonly<{ kind: 'signIn' }>
    | Readonly<{ kind: 'retry' }>
    | Readonly<{ kind: 'cancel' }>
    | Readonly<{ kind: 'showTerminal' }>
    | Readonly<{ kind: 'guide'; url: string }>
    /** Uninstall a Happier-managed install from this machine (offered beside the row's own action). */
    | Readonly<{ kind: 'remove' }>;

/** Actions that mutate a machine or an install job and therefore require machine Manage access. */
export function isMachineAgentRowActionManageOnly(action: MachineAgentRowAction): boolean {
    return action.kind === 'install'
        || action.kind === 'update'
        || action.kind === 'retry'
        || action.kind === 'cancel'
        || action.kind === 'remove';
}

export type MachineAgentStatusTone = 'quiet' | 'warn' | 'bad';

export type MachineAgentStatus =
    | Readonly<{ kind: 'ready'; tone: 'quiet'; via: 'connected' | 'native'; label: string | null; updateTo: string | null }>
    | Readonly<{ kind: 'needsSignIn'; tone: 'warn' }>
    | Readonly<{ kind: 'waitingForSignIn'; tone: 'quiet' }>
    | Readonly<{ kind: 'notInstalled'; tone: 'quiet'; sizeBytes: number | null; manual: boolean }>
    | Readonly<{ kind: 'unsupported'; tone: 'warn'; reason: 'os' | 'arch' }>
    | Readonly<{ kind: 'installing'; tone: 'quiet'; stepLabel: string | null; bytesDone: number | null; bytesTotal: number | null }>
    | Readonly<{ kind: 'failed'; tone: 'bad'; failure: MachineAgentJobFailure }>
    | Readonly<{ kind: 'checking'; tone: 'quiet' }>
    | Readonly<{ kind: 'offline'; tone: 'quiet'; lastKnown: 'signedIn' | 'signedOut' | 'notInstalled' | 'unknown' }>
    | Readonly<{ kind: 'unavailable'; tone: 'quiet'; reason: NonNullable<MachineAgent['unavailableReason']> }>
    | Readonly<{ kind: 'signInUnknown'; tone: 'quiet' }>
    | Readonly<{ kind: 'unknown'; tone: 'quiet' }>;

function isJobRunning(agent: MachineAgent): boolean {
    return agent.job !== null && agent.job.outcome === null;
}

function jobFailure(agent: MachineAgent) {
    const outcome = agent.job?.outcome;
    return outcome && outcome.kind === 'failed' && outcome.code !== 'cancelled' ? outcome : null;
}

/**
 * This Machine's install job put the agent here and settled: the setup flow carries on into sign-in
 * on the same steps (and the engine rail keeps the setup pane) while the Machine reads its sign-in.
 */
export function isMachineAgentInstalledBySetup(agent: MachineAgent): boolean {
    return agent.installed && agent.job?.intent === 'install' && agent.job.outcome?.kind === 'succeeded';
}

function isSignInOpen(session: MachineAgentSignInSession | null | undefined): boolean {
    return session?.phase === 'opening' || session?.phase === 'waiting';
}

export function resolveAgentSetupPhase(agent: MachineAgent, session?: MachineAgentSignInSession | null): AgentSetupPhase {
    if (agent.job?.readFailure && !agent.job.outcome) return 'unknown';
    if (isJobRunning(agent)) return 'installing';
    if (jobFailure(agent)) return 'installFailed';
    if (!agent.platform.supported || agent.state === 'unsupported') return 'unsupported';
    switch (agent.state) {
        case 'installing':
            return 'installing';
        case 'failed':
            return 'installFailed';
        case 'notInstalled':
            return agent.install.available ? 'install' : 'manualInstall';
        case 'needsSignIn':
            return isSignInOpen(session) ? 'waitingForSignIn' : 'signIn';
        case 'ready':
        case 'updateAvailable':
            return 'ready';
        case 'checking':
            return 'checking';
        case 'unknown':
            return 'unknown';
    }
}

/** The one action beside a row or card; null when there is nothing to do (healthy, offline, unsupported). */
export function resolveMachineAgentRowAction(
    agent: MachineAgent,
    session?: MachineAgentSignInSession | null,
): MachineAgentRowAction | null {
    if (agent.stale) return null;
    const phase = resolveAgentSetupPhase(agent, session);
    switch (phase) {
        case 'installing': return { kind: 'cancel' };
        case 'installFailed': return { kind: 'retry' };
        case 'install': return { kind: 'install' };
        case 'manualInstall': return agent.install.guideUrl ? { kind: 'guide', url: agent.install.guideUrl } : null;
        case 'signIn': return { kind: 'signIn' };
        case 'waitingForSignIn': return { kind: 'showTerminal' };
        case 'ready':
            return agent.state === 'updateAvailable' && agent.update?.supported === true ? { kind: 'update' } : null;
        case 'unsupported':
        case 'checking':
            return null;
        case 'unknown':
            return agent.job?.readFailure ? { kind: 'retry' } : null;
    }
}

function runningStep(agent: MachineAgent) {
    const steps = agent.job?.steps ?? [];
    return steps.find((step) => step.state === 'running') ?? steps.find((step) => step.state === 'pending') ?? null;
}

/**
 * Nothing has asked the machine about this agent yet (an embedded composer before anyone uses it): the
 * inventory is idle and holds no answer. That is neither a check in progress nor a failed one, so a status
 * line has nothing honest to say until the check is requested.
 */
export function isMachineAgentUnchecked(
    agent: MachineAgent | null,
    inventoryStatus?: MachineAgentsSnapshot['status'],
): boolean {
    return inventoryStatus === 'idle' && (!agent || agent.state === 'unknown');
}

/** The one status line of a row or card. Only trouble has a tone. */
export function resolveMachineAgentStatus(
    agent: MachineAgent | null,
    session?: MachineAgentSignInSession | null,
    inventoryStatus?: MachineAgentsSnapshot['status'],
    inventoryFailure?: MachineAgentsSnapshot['failure'],
): MachineAgentStatus {
    // A missing or unanswered row is not a failed check while its inventory is loading.
    // Retained installation/authentication facts still speak during a refresh.
    if (inventoryStatus === 'loading' && (!agent || agent.state === 'unknown' || agent.state === 'checking')) {
        return { kind: 'checking', tone: 'quiet' };
    }
    const failure = agent?.unavailableReason ?? inventoryFailure;
    if (failure && inventoryStatus !== 'offline' && agent?.staleReason !== 'offline') return { kind: 'unavailable', tone: 'quiet', reason: failure };
    if (!agent) return { kind: 'unknown', tone: 'quiet' };
    if (agent.stale) {
        if (agent.staleReason === 'error') return { kind: 'unknown', tone: 'quiet' };
        const lastKnown = !agent.installed
            ? 'notInstalled'
            : agent.signIn.status === 'signedIn' ? 'signedIn' : agent.signIn.status === 'signedOut' ? 'signedOut' : 'unknown';
        return { kind: 'offline', tone: 'quiet', lastKnown };
    }
    const phase = resolveAgentSetupPhase(agent, session);
    switch (phase) {
        case 'installing': {
            const step = runningStep(agent);
            return { kind: 'installing', tone: 'quiet', stepLabel: step?.label ?? null, bytesDone: step?.bytesDone ?? null, bytesTotal: step?.bytesTotal ?? null };
        }
        case 'installFailed':
            return { kind: 'failed', tone: 'bad', failure: jobFailure(agent) ?? UNKNOWN_FAILURE };
        case 'unsupported':
            return { kind: 'unsupported', tone: 'warn', reason: agent.platform.supported ? 'os' : agent.platform.reason };
        case 'install':
        case 'manualInstall':
            return { kind: 'notInstalled', tone: 'quiet', sizeBytes: agent.install.sizeBytes, manual: phase === 'manualInstall' };
        case 'signIn':
            return { kind: 'needsSignIn', tone: 'warn' };
        case 'waitingForSignIn':
            return { kind: 'waitingForSignIn', tone: 'quiet' };
        case 'ready': {
            const via = agent.signIn.via;
            const updateTo = agent.state === 'updateAvailable' ? agent.latestVersion : null;
            if (via?.kind === 'connected') return { kind: 'ready', tone: 'quiet', via: 'connected', label: via.profileLabel ?? via.title, updateTo };
            return { kind: 'ready', tone: 'quiet', via: 'native', label: via?.kind === 'native' ? via.accountLabel : null, updateTo };
        }
        case 'checking':
            return { kind: 'checking', tone: 'quiet' };
        case 'unknown':
            return agent.installed && agent.signIn.status === 'unknown'
                ? { kind: 'signInUnknown', tone: 'quiet' }
                : { kind: 'unknown', tone: 'quiet' };
    }
}

/**
 * Where an agent sits in the engine popover's rail for the composer's machine (user ruling 2026-09-30:
 * the real rail + pane popover): agents on the machine first, then "Not on <machine> yet" marked with a
 * download glyph, then the ones that can't run there. `opensSetup`: selecting the row shows the setup
 * form in the right pane instead of the models, and never makes it the session's agent. Null (nothing
 * known yet) keeps today's placement: a row is never hidden or blocked on a missing answer.
 */
export type MachineAgentPickerPlacement = Readonly<{
    group: 'onMachine' | 'notOnMachine' | 'cantRun';
    marker: 'none' | 'needsSignIn' | 'download' | 'installing' | 'failed' | 'unsupported';
    opensSetup: boolean;
}>;

export function resolveMachineAgentPickerPlacement(
    agent: MachineAgent | null,
    session?: MachineAgentSignInSession | null,
): MachineAgentPickerPlacement {
    if (!agent) return { group: 'onMachine', marker: 'none', opensSetup: false };
    const opensSetup = !(agent.stale && agent.staleReason === 'offline');
    const phase = resolveAgentSetupPhase(agent, session);
    switch (phase) {
        case 'checking':
        case 'unknown':
            // Just installed: the pane stays on its steps while the Machine reads the sign-in.
            return isMachineAgentInstalledBySetup(agent) || agent.job?.readFailure
                ? { group: 'onMachine', marker: phase === 'checking' ? 'installing' : 'none', opensSetup }
                : { group: 'onMachine', marker: 'none', opensSetup: false };
        case 'ready':
            return { group: 'onMachine', marker: 'none', opensSetup: false };
        case 'signIn':
        case 'waitingForSignIn':
            return { group: 'onMachine', marker: 'needsSignIn', opensSetup };
        case 'install':
        case 'manualInstall':
            return { group: 'notOnMachine', marker: 'download', opensSetup };
        case 'installing':
            return { group: agent.installed ? 'onMachine' : 'notOnMachine', marker: 'installing', opensSetup: opensSetup && !isMachineAgentReady(agent) };
        case 'installFailed':
            return { group: agent.installed ? 'onMachine' : 'notOnMachine', marker: 'failed', opensSetup: opensSetup && !isMachineAgentReady(agent) };
        case 'unsupported':
            return { group: 'cantRun', marker: 'unsupported', opensSetup };
    }
}

/**
 * Installed agents first (what this machine runs today), then what could run here; never what can't. An
 * agent installed from "Add an agent" during this run keeps its place while its form finishes the setup
 * (its install job is still held), so the open form never jumps between groups.
 */
/**
 * The machine's agents in the section's two groups. An agent installed here keeps the place its setup form opened
 * in (Add an agent) while that form stays open, so it does not jump groups mid-setup; closed, it is listed as
 * installed. `anyInstalled` is the one "is anything on this machine" fact, whichever group shows the agent.
 */
export function splitMachineAgents(
    agents: readonly MachineAgent[],
    isFormOpen: (agent: MachineAgent) => boolean,
): Readonly<{ installed: MachineAgent[]; available: MachineAgent[]; anyInstalled: boolean }> {
    const installed: MachineAgent[] = [];
    const available: MachineAgent[] = [];
    let anyInstalled = false;
    for (const agent of agents) {
        const keepsSetupPlace = agent.job?.intent === 'install' && isFormOpen(agent);
        if (agent.installed) anyInstalled = true;
        if (agent.installed && !keepsSetupPlace) installed.push(agent);
        else if (agent.platform.supported) available.push(agent);
    }
    return { installed, available, anyInstalled };
}

/**
 * Why the composer can't start a session with the chosen agent on the chosen machine, and the fix
 * (lab `agent-setup` ST "session start"): not on the machine yet → Set up; signed out → Sign in. Null
 * when the agent can start (or nothing is known yet: the spawn's typed failure still speaks then).
 */
export function resolveAgentSessionStartBlock(agent: MachineAgent | null): 'notInstalled' | 'signedOut' | null {
    if (!agent || agent.stale || isMachineAgentReady(agent)) return null;
    switch (resolveAgentSetupPhase(agent)) {
        case 'install':
        case 'manualInstall':
        case 'installing':
        case 'installFailed':
        case 'unsupported':
            return 'notInstalled';
        case 'signIn':
        case 'waitingForSignIn':
            return 'signedOut';
        default:
            return null;
    }
}

/** How many agents the block offers before "All agents" (lab H1: three). */
const FIRST_AGENT_CHOICES = 3;

/**
 * The agents Home offers first on a machine with none (lab H1): ones whose connected service is already
 * connected lead (they sign in with nothing more to do), then the rest in catalog order. Only agents that
 * can run on the machine and Happier can install.
 */
export function rankFirstAgentChoices(agents: readonly MachineAgent[]): Readonly<{ choices: MachineAgent[]; more: number }> {
    const candidates = agents.filter((agent) => !agent.installed && agent.platform.supported && agent.install.available);
    const connected = (agent: MachineAgent) => agent.signIn.connectedServices.some((service) => service.connected && service.healthy);
    const ranked = [...candidates.filter(connected), ...candidates.filter((agent) => !connected(agent))];
    return { choices: ranked.slice(0, FIRST_AGENT_CHOICES), more: Math.max(0, ranked.length - FIRST_AGENT_CHOICES) };
}

/**
 * Home offers "Set up your first agent" only while the composer's machine is known to have no agent at
 * all (lab H1): facts are in (fresh or last known), there are agents it could run, and none is installed.
 */
export function shouldOfferFirstAgentSetup(inventory: Pick<MachineAgentsSnapshot, 'status' | 'agents'>): boolean {
    return (inventory.status === 'ready' || inventory.status === 'offline')
        && inventory.agents.length > 0
        && !inventory.agents.some((agent) => agent.installed);
}
