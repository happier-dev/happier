/**
 * The per-machine agent inventory as every UI surface reads it (lab `agent-setup`): the machine page's
 * Agents section, Settings → Agents, the engine popover, Home's "Set up your first agent" and the
 * session-start guard. One model, decided once by `resolveMachineAgentState` in this folder; surfaces
 * never re-derive installed / signed-in / update / supported from capability snapshots themselves.
 *
 * Owners: the inventory hook (`useMachineAgents`), the install job client (`installJobs/`) and the
 * sign-in client (`signIn/`) all live in this folder and produce these shapes.
 */

import type { AgentId } from '@happier-dev/agents';
import type { MachineAgentInventoryItem, MachineAgentInventoryUnavailable } from '@happier-dev/protocol/capabilities';

/** The one state a surface shows for an agent on a machine (first match wins, see the resolver). */
export type MachineAgentState =
    /** Installed and signed in (natively or through a healthy connected account). */
    | 'ready'
    /** Installed, but neither the agent's own probe nor a connected account says it can sign in. */
    | 'needsSignIn'
    /** Ready, and a newer version is available from a source Happier can update from. */
    | 'updateAvailable'
    /** Not on the machine, and it could be (the platform is supported). */
    | 'notInstalled'
    /** No build for this machine's OS or CPU: never offered an install. */
    | 'unsupported'
    /** A probe is running and no last-known facts exist yet. */
    | 'checking'
    /** An install or update job is running. */
    | 'installing'
    /** The last install or update job failed. */
    | 'failed'
    /** The machine could not answer and nothing is known. */
    | 'unknown';

export type MachineAgentSignInStatus = 'signedIn' | 'signedOut' | 'unknown';

export type MachineAgentConnectedService = Readonly<{
    serviceId: string;
    /** "Claude subscription", "ChatGPT". */
    title: string;
    connected: boolean;
    healthy: boolean;
    /** The connected account's label ("Work · Max"), when connected. */
    profileLabel: string | null;
    /** Exact account health; absent while descriptor/transport facts cannot evaluate profiles. */
    profiles?: readonly Readonly<{ profileId: string; healthy: boolean; profileLabel: string | null }>[];
}>;

export type MachineAgentSignIn = Readonly<{
    /** Retained probe facts; aggregate connected availability does not replace native authentication. */
    native?: MachineAgentInventoryItem['signIn'];
    status: MachineAgentSignInStatus;
    /** How it is signed in, when it is. */
    via:
        | Readonly<{ kind: 'connected'; serviceId: string; title: string; profileLabel: string | null }>
        | Readonly<{ kind: 'native'; accountLabel: string | null }>
        | null;
    /** The agent's own login, from its manifest. `unsupported` = it has none (Gemini: key or account only). */
    nativeLogin: 'terminal' | 'statusOnly' | 'manual' | 'unsupported';
    /** Connected services this agent accepts, in the order the form offers them (first = recommended). */
    connectedServices: readonly MachineAgentConnectedService[];
}>;

export type MachineAgentPlatform =
    | Readonly<{ supported: true }>
    | Readonly<{ supported: false; reason: 'os' | 'arch' }>;

export type MachineAgentInstall = Readonly<{
    /** Happier can install it on this machine (managed or vendor recipe). */
    available: boolean;
    mode: 'managed' | 'vendor_recipe' | 'manual' | 'none';
    /** Download size when the manifest knows it (pinned archives); never guessed. */
    sizeBytes: number | null;
    guideUrl: string | null;
    /** The install needs consent to run the vendor's own installer script. */
    requiresVendorConsent: boolean;
}>;

export type MachineAgentDependency = Readonly<{
    key: string;
    title: string;
    installed: boolean;
    version: string | null;
}>;

export type MachineAgentJobStepState = 'pending' | 'running' | 'done' | 'failed';

export type MachineAgentJobStep = Readonly<{
    stepId: string;
    label: string;
    state: MachineAgentJobStepState;
    bytesDone: number | null;
    bytesTotal: number | null;
}>;

export type MachineAgentJobFailureCode =
    | 'consent_required'
    | 'unsupported_platform'
    | 'install_not_available'
    | 'download_failed'
    | 'verification_failed'
    | 'timeout'
    | 'cancelled'
    | 'install_failed'
    | 'update_not_available'
    | 'machine_unreachable'
    | 'unknown';

export type MachineAgentJob = Readonly<{
    jobId: string;
    intent: 'install' | 'update';
    startedAtMs: number;
    steps: readonly MachineAgentJobStep[];
    /** The last short log line (a file name and byte count), when the daemon reports one. */
    logLine: string | null;
    outcome:
        | null
        | Readonly<{ kind: 'succeeded'; version: string | null }>
        | Readonly<{ kind: 'failed'; code: MachineAgentJobFailureCode; stepId: string | null; message: string | null; guideUrl?: string }>;
}>;

export type MachineAgent = Readonly<{
    agentId: AgentId;
    title: string;
    state: MachineAgentState;
    installed: boolean;
    version: string | null;
    latestVersion: string | null;
    update: Readonly<{ supported: boolean; command: string | null }> | null;
    signIn: MachineAgentSignIn;
    platform: MachineAgentPlatform;
    install: MachineAgentInstall;
    dependencies: readonly MachineAgentDependency[];
    job: MachineAgentJob | null;
    /** Last-known facts of a machine that is not answering right now. */
    stale: boolean;
    /** The latest probe failed; retained facts cannot admit a Session. */
    unavailableReason?: Omit<MachineAgentInventoryUnavailable, 'agentId'>;
}>;

/** The native sign-in running in a machine terminal (T1), shared by the bottom pane, the form and the phone sheet. */
export type MachineAgentSignInSession = Readonly<{
    phase: 'idle' | 'opening' | 'waiting' | 'signedIn' | 'failed';
    terminalKey: string | null;
    /** The sign-in link the terminal printed (`url` events with kind `auth`). */
    authUrl: string | null;
    startedAtMs: number | null;
    failure: string | null;
}>;
