import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import type { MachineAgent, MachineAgentConnectedService, MachineAgentSignIn } from './machineAgentTypes';
import { resolveMachineAgentState } from './resolveMachineAgentState';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServicesAccountGroupOptionsByServiceId } from '@happier-dev/agents';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { areTeamResourceConnectedServiceSelectionsEqual } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

const NATIVE_LOGIN = { login_terminal: 'terminal', status_only: 'statusOnly', manual_only: 'manual', unsupported: 'unsupported' } as const;

export function resolveMachineAgentSignIn(input: Readonly<{
    native: MachineAgentInventoryItem['signIn'];
    connectedServices: readonly MachineAgentConnectedService[];
    /** Omitted for aggregate inventory; null means launch uses native authentication. */
    credentialBindings?: ConnectedServiceBindingsV2 | null;
    groupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    /** Services replaced by the admitted selected Provider's Agent adapter. */
    suppressedServiceIds?: ReadonlySet<string>;
}>): MachineAgentSignIn {
    const services = input.connectedServices.filter(service => !input.suppressedServiceIds?.has(service.serviceId));
    const selected = input.credentialBindings === undefined ? services : services.map((service) => {
        const binding = input.credentialBindings?.bindingsByServiceId[service.serviceId];
        if (!binding || binding.source === 'native') return { ...service, connected: false, healthy: false };
        if (binding.source === 'team_resource') {
            const resource = input.teamCredentialResources?.find((resource) => resource.id === binding.resourceId
                && resource.readiness.kind === 'available'
                && resource.connectedServiceSelections.some((selection) => selection.resourceId === binding.resourceId
                    && areTeamResourceConnectedServiceSelectionsEqual(selection, binding)));
            return { ...service, connected: true, healthy: Boolean(resource) };
        }
        const profileId = binding.selection === 'profile' ? binding.profileId
            : input.groupOptionsByServiceId?.[service.serviceId]?.find((group) => group.groupId === binding.groupId)?.activeProfileId;
        const profile = service.profiles?.find((profile) => profile.profileId === profileId);
        return { ...service, connected: Boolean(profile), healthy: profile?.healthy === true, profileLabel: profile?.profileLabel ?? null };
    });
    const connected = selected.find((service) => service.connected && service.healthy);
    const selectedBindings = Object.entries(input.credentialBindings?.bindingsByServiceId ?? {})
        .filter(([serviceId, binding]) => binding.source !== 'native' && !input.suppressedServiceIds?.has(serviceId));
    const usesConnected = selectedBindings.length > 0;
    // Absent profile rows mean the projection could not evaluate authentication,
    // unlike an evaluated empty list or a known unhealthy selected profile.
    const unknown = selectedBindings.some(([serviceId, binding]) => {
        const service = input.connectedServices.find((service) => service.serviceId === serviceId);
        return !service || (binding.source === 'connected' && service.profiles === undefined);
    });
    const status = connected ? 'signedIn' : usesConnected ? unknown ? 'unknown' : 'signedOut' : input.native.status;
    return {
        native: input.native,
        status,
        via: connected
            ? { kind: 'connected', serviceId: connected.serviceId, title: connected.title, profileLabel: connected.profileLabel }
            : status === 'signedIn' ? { kind: 'native', accountLabel: input.native.accountLabel ?? null } : null,
        nativeLogin: NATIVE_LOGIN[input.native.loginSupport],
        connectedServices: input.connectedServices,
    };
}

/** Launch projection reuses inventory sign-in and state decisions without changing aggregate rows. */
export function projectMachineAgentForCredential(agent: MachineAgent | null | undefined, selection: Readonly<{
    credentialBindings: ConnectedServiceBindingsV2 | null;
    providerRoute?: Readonly<{ ready: boolean; suppressedConnectedServiceIds: readonly string[] }> | null;
}> & Pick<Parameters<typeof resolveMachineAgentSignIn>[0], 'groupOptionsByServiceId' | 'teamCredentialResources'>): MachineAgent | null {
    if (!agent) return null;
    const suppressedServiceIds = new Set((selection.providerRoute?.ready ? selection.providerRoute.suppressedConnectedServiceIds : [])
        .map(resolveQualifiedConnectedAccountServiceKey).filter((key): key is string => key !== null));
    // Suppression must cover the Agent's actual accepted authentication services,
    // not merely a same-named service belonging to another plugin.
    const authenticationRequired = agent.signIn.connectedServices.length === 0
        || agent.signIn.connectedServices.some(service => !suppressedServiceIds.has(service.serviceId))
        || Object.keys(selection.credentialBindings?.bindingsByServiceId ?? {}).some(serviceId => !suppressedServiceIds.has(serviceId));
    const signIn = resolveMachineAgentSignIn({
        native: agent.signIn.native ?? { status: agent.signIn.via?.kind === 'connected' ? 'unknown' : agent.signIn.status, loginSupport: 'unsupported' },
        connectedServices: agent.signIn.connectedServices,
        ...selection,
        suppressedServiceIds,
    });
    return { ...agent, signIn, state: resolveMachineAgentState({ ...agent, signIn,
        known: agent.state !== 'unknown' && agent.state !== 'checking', checking: agent.state === 'checking', requireSignedIn: true,
        credentialRouteReady: selection.providerRoute?.ready, authenticationRequired }) };
}

export function projectMachineAgent(input: Readonly<{
    agentId: string;
    title: string;
    facts: MachineAgentInventoryItem | null;
    checking: boolean;
    stale: boolean;
    unavailableReason?: MachineAgent['unavailableReason'];
    connectedServices: readonly MachineAgentConnectedService[];
    job: MachineAgent['job'];
    dependencyTitlesByKey?: Readonly<Record<string, string>>;
}>): MachineAgent {
    const facts = input.facts;
    const agent = {
        agentId: input.agentId, title: input.title,
        installed: facts?.installed ?? false,
        version: facts?.version ?? null, latestVersion: facts?.latestVersion ?? null,
        update: facts?.update ?? null,
        signIn: resolveMachineAgentSignIn({ native: facts?.signIn ?? { status: 'unknown', loginSupport: 'unsupported' }, connectedServices: input.connectedServices }),
        platform: facts?.platform ?? { supported: true as const },
        install: { ...(facts?.install ?? { available: false, mode: 'none' as const, sizeBytes: null, guideUrl: null }), requiresVendorConsent: facts?.install.mode === 'vendor_recipe' },
        dependencies: (facts?.dependencies ?? []).map((dependency) => ({ ...dependency, title: input.dependencyTitlesByKey?.[dependency.key] ?? dependency.key })),
        job: input.job, stale: input.stale || Boolean(input.unavailableReason),
        ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    };
    return { ...agent, state: resolveMachineAgentState({ ...agent, known: facts !== null && !input.unavailableReason, checking: input.checking }) };
}

/** Keep unchanged agent rows and nested facts stable across refresh and unrelated agent updates. */
export function reconcileMachineAgents(previous: readonly MachineAgent[], incoming: readonly MachineAgent[]): readonly MachineAgent[] {
    const previousById = new Map(previous.map((agent) => [agent.agentId, agent]));
    const reconciled = incoming.map((agent) => {
        const prior = previousById.get(agent.agentId);
        return prior && JSON.stringify(prior) === JSON.stringify(agent) ? prior : agent;
    });
    return previous.length === reconciled.length && reconciled.every((agent, index) => agent === previous[index]) ? previous : reconciled;
}
