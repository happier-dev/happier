/**
 * The per-machine agent inventory as every UI surface reads it (lab `agent-setup`): the machine page's
 * Agents section, Settings → Agents, the engine popover, Home's "Set up your first agent" and the
 * session-start guard. One model, decided once by `resolveMachineAgentState` in this folder; surfaces
 * never re-derive installed / signed-in / update / supported from capability snapshots themselves.
 *
 * Owners: the inventory hook (`useMachineAgents`), the install job client (`installJobs/`) and the
 * sign-in client (`signIn/`) all live in this folder and produce these shapes.
 */

import type { AgentId, ConnectedServicesAccountGroupOption } from '@happier-dev/agents';
import type { MachineAgentInventoryItem, MachineAgentInventoryUnavailable } from '@happier-dev/protocol/capabilities';
import type { AgentInstallJobFailureCode, AgentInstallJobIntent, AgentInstallJobOutcome } from '@happier-dev/protocol/daemon/agent-install-jobs';

/** The one state a surface shows for an agent on a machine (first match wins, see the resolver). */
export type MachineAgentState =
    /** Installed with required authentication satisfied, or explicitly not required. */
    | 'ready'
    /** Installed, but the selected Account default or Session credential is signed out. */
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
    profiles?: readonly Readonly<{ profileId: string; healthy: boolean; profileLabel: string | null; providerEmail?: string | null; reconnectRequired?: boolean }>[];
    groups?: readonly ConnectedServicesAccountGroupOption[];
}>;

export type MachineAgentSignIn = Readonly<{
    /** Exact selected account refusal; native sign-in and sibling accounts cannot repair it. */
    connectedAccountFailure?: Readonly<{
        code: 'connected_service_credential_reconnect_required';
        serviceId: string;
        profileId: string;
    }>;
    /** Retained native probe facts; projecting a selected credential never replaces these. */
    native?: MachineAgentInventoryItem['signIn'];
    status: MachineAgentSignInStatus;
    /** How it is signed in, when it is. */
    via:
        | Readonly<{ kind: 'connected'; serviceId: string; title: string; profileLabel: string | null }>
        | Readonly<{ kind: 'native'; accountLabel: string | null }>
        | null;
    /** The agent's own login, from its manifest. `unsupported` = it has none (Gemini: key or account only). */
    nativeLogin: 'terminal' | 'statusOnly' | 'manual' | 'unsupported';
    /** Connected services this agent accepts, in declaration order. */
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

export type MachineAgentJobFailureCode = AgentInstallJobFailureCode;

export type MachineAgentJob = Readonly<{
    jobId: string;
    intent: AgentInstallJobIntent;
    startedAtMs: number;
    steps: readonly MachineAgentJobStep[];
    /** The last short log line (a file name and byte count), when the daemon reports one. */
    logLine: string | null;
    outcome: AgentInstallJobOutcome | null;
}>;

export type MachineAgent = Readonly<{
    agentId: AgentId;
    definitionId?: string;
    managed?: boolean;
    fit?: MachineAgentInventoryItem['fit'];
    title: string;
    state: MachineAgentState;
    /** Inventory-owned last verified sign-in attention, retained through an unverified refresh.
     * Absent before verification or after resolution; execution still uses state and stale. */
    signInTrouble?: true;
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
    /** Presence loss and failed checks both invalidate facts, but only presence loss means offline. */
    staleReason?: 'offline' | 'error';
    /** The latest probe failed; retained facts cannot admit a Session. */
    unavailableReason?: Omit<MachineAgentInventoryUnavailable, 'agentId' | 'definitionId'>;
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
