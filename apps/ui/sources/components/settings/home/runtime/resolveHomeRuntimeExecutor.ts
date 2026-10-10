import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Who can act on the runtime that serves one Home (plan `2026-09-26-home-owner-console` §3.2, §3.7,
 * §3.14 "Restart now"). The one rule every console surface uses — Reach's access method, Runtime,
 * Backups and Server settings' Restart now — so no surface offers a control this device cannot run:
 *
 * - `hosting_desktop`: this desktop runs the Home (its own Personal Home) and has the system-task
 *   bridge, so relay-runtime, relay-access and Personal Home tasks run locally;
 * - `remote_host`: a saved Remote host is linked to this Home and this device can reach it over SSH;
 * - `connected_machine`: that Remote host's Machine is connected to this Home, so its daemon runs
 *   the relay-runtime task (`tool.systemTasks`) from any client;
 * - `elsewhere`: the Home runs somewhere this device cannot act on (named when known);
 * - `deployment`: a full-flavour server whose runtime belongs to its deployment.
 *
 * Identity, never an address, binds a runtime to a Home: the Personal Home receipt this device
 * wrote at setup, or the Home profile a Remote host was linked to.
 */
export type HomeRuntimeExecutor =
    | Readonly<{ kind: 'hosting_desktop' }>
    | Readonly<{ kind: 'remote_host'; host: RemoteHost; hostName: string; scope: ServerAccountScope; catalogRevision: number }>
    | Readonly<{ kind: 'connected_machine'; machineId: string; hostName: string }>
    | Readonly<{ kind: 'elsewhere'; hostName: string | null }>
    | Readonly<{ kind: 'deployment' }>;

export type HomeRuntimeExecutorFacts = Readonly<{
    serverId: string;
    /** `capabilities.serverRelease.flavor` of the Home, when it publishes one. */
    flavor: 'light' | 'full' | null;
    /** This device runs system tasks (the desktop bridge). */
    localBridgeAvailable: boolean;
    /** The Home this device set up as its own Personal Home, by scope id. */
    locallyHostedServerId: string | null;
    remoteHosts: readonly RemoteHost[];
    remoteHostScope: ServerAccountScope | null;
    /** Only a complete, current catalog may authorize an SSH operation. */
    remoteHostCatalogRevision: number | null;
    /** Scope id of a saved Home profile, or `null` when the profile is gone. */
    scopeIdOfProfile: (profileId: string) => string | null;
}>;

export function resolveHomeRuntimeExecutor(facts: HomeRuntimeExecutorFacts): HomeRuntimeExecutor {
    if (facts.flavor === 'full') return { kind: 'deployment' };
    if (facts.localBridgeAvailable && facts.locallyHostedServerId === facts.serverId) return { kind: 'hosting_desktop' };
    const linked = facts.remoteHosts.find((host) => (
        host.linkedRelayProfileId ? facts.scopeIdOfProfile(host.linkedRelayProfileId) === facts.serverId : false
    ));
    if (linked && facts.localBridgeAvailable) {
        if (!facts.remoteHostScope || facts.remoteHostCatalogRevision === null) return { kind: 'elsewhere', hostName: linked.name };
        return { kind: 'remote_host', host: linked, hostName: linked.name,
            scope: facts.remoteHostScope, catalogRevision: facts.remoteHostCatalogRevision };
    }
    if (linked?.linkedMachineId) return { kind: 'connected_machine', machineId: linked.linkedMachineId, hostName: linked.name };
    return { kind: 'elsewhere', hostName: linked?.name ?? null };
}

export function homeRuntimeExecutorCanAct(executor: HomeRuntimeExecutor): boolean {
    return executor.kind === 'hosting_desktop' || executor.kind === 'remote_host' || executor.kind === 'connected_machine';
}
