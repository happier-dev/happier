import * as React from 'react';
import { t } from '@/text';
import { storage, useArtifact, useMachineDisplayNamesById, useProjectAccountRows, useServerScopedMachine } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent, getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { describeUnnamedApprovalSession, resolveApprovalHomeName, resolveApprovalHomeSentenceName } from './approvalRequesterLabels';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { projectMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { getProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readCurrentProjectAccountRows, useProjectAccountWorkspaceRef, type ProjectAccountRowsSnapshot, type ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import { useApprovalSessionReading } from './useApprovalSessionReading';
import { useWorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { endpointFor, type WorkspaceSyncRelationshipEndpoint, type WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { formatWorkspaceSyncRelationshipTitle } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { createManagedMachineActionClient } from '@/sync/api/machines/managedMachineActions';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { readTeam, readTeamCredentialResourceCatalogs } from '@/sync/store/teams/teamsSnapshots';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { useProjectedQualifiedConnectedAccountTargetPresentations, type ProjectedQualifiedConnectedAccountTarget } from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
type ApprovalReference = ApprovalActionReference;

export type ApprovalReferenceReading = Readonly<{ text: string; named: boolean; resolving?: boolean; subject?: 'managedMachine';
    /** A Session this device read: the reference opens it. */
    session?: Readonly<{ id: string; serverId: string | null }> }>;

/** Both cached UI rows and authorized exact reads use the same content-readable name rule. */
function readApprovalArtifactReference(reference: ApprovalReference, artifact: DecryptedArtifact | null | undefined): ApprovalReferenceReading {
    const readable = artifact?.isDecrypted === true && (reference.kind === 'artifact'
        || reference.kind === 'skill' && artifact.header?.kind === 'prompt_bundle.v2'
            && artifact.header.bundleSchemaId === 'skills.skill_md_v1');
    const title = readable ? artifact.title?.trim() || artifact.header?.title?.trim() : null;
    return { text: title || reference.id, named: Boolean(title) };
}

function readApprovalProject(reference: ApprovalReference | undefined, rows: ProjectAccountRowsSnapshot | null,
    viewer: ApprovalReferenceSources['viewer'], approvalServerId: string | null): ProjectOrganizationRow | null {
    return reference?.kind === 'project' && rows && viewer && rows.scope.accountId === viewer.accountId
        && areServerProfileIdentifiersEquivalent(viewer.serverId, approvalServerId) && areServerProfileIdentifiersEquivalent(rows.scope.serverId, approvalServerId)
        ? rows.organizations.find(row => row.key.projectKey === reference.id) ?? null : null;
}

/** An invocation has captured its Account; references are read there, never on the focused Home. */
export async function readApprovalReferenceForConfirmation(reference: ApprovalReference | undefined,
    account: LazyActionAccountContext, signal?: AbortSignal): Promise<ApprovalReferenceReading> {
    if (!reference) return { text: '', named: false };
    const scope = { serverId: account.serverId, accountId: account.accountId };
    const teamScope = { ...scope, serverId: resolveServerProfileScopeIdForIdentifier(scope.serverId) };
    const teamSource = reference.kind === 'providerConnection' || reference.kind === 'providerModel'
        ? findApprovalProviderSource(reference, readTeamCredentialResourceCatalogs(teamScope)) : undefined;
    const teamResources = teamSource ? [teamSource] : [];
    const state = storage.getState();
    const projects = readCurrentProjectAccountRows(state);
    const sources: ApprovalReferenceSources = {
        serverId: reference.kind === 'session' ? reference.serverId ?? account.serverId : account.serverId,
        viewer: scope, ownHome: true, sessionReading: { name: null, machineId: '', status: 'unavailable' },
        // Account references carry no execution Machine from which to admit installed declarations.
        declarations: readAccountProviderDeclarations({ kind: 'account' }),
        machine: reference.kind === 'machine' ? resolveServerScopedMachine(state, account.serverId, reference.id) : null,
        registries: getPromptLibraryCatalogValue(scope, 'registry-sources'),
        project: readApprovalProject(reference, projects, scope, account.serverId),
        projectCensusComplete: projects?.status === 'ready' && projects.coverage === 'complete',
        providerCatalog: getProviderCatalogSnapshot(scope),
        teamResources,
        teamNameById: reference.kind === 'providerConnection' && teamSource
            ? { [teamSource.teamId]: readTeam(teamScope, { serverId: teamScope.serverId, teamId: teamSource.teamId })?.name ?? '' }
            : {},
    };
    if (reference.kind === 'artifact' || reference.kind === 'skill') {
        sources.artifact = await account.fetchArtifact(reference.id, { signal });
        account.assertCurrent();
    }
    if (reference.kind === 'mcpServer') {
        const snapshot = await readMcpServerCatalogInContext(account, signal);
        account.assertCurrent();
        sources.mcp = projectMcpServerCatalogSnapshot(snapshot);
    }
    if (reference.kind === 'managedMachine' && reference.homeId === account.serverIdentityId) {
        try {
            account.assertCurrent();
            const machine = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                { homeId: reference.homeId, managedId: reference.id }, { signal });
            if (machine.id === reference.id && machine.homeId === reference.homeId) sources.managedMachine = machine;
        } catch {
            // A display reference may be unreadable; it never grants resource access.
        }
        account.assertCurrent();
        sources.managedEnrolledMachine = sources.managedMachine?.enrolledMachineId
            ? resolveServerScopedMachine(storage.getState(), account.serverId, sources.managedMachine.enrolledMachineId) : null;
    }
    return resolveApprovalReferenceReading(reference, reference.id, account.serverId, sources);
}

export function useApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null,
    /** A page opened by a link mounts no Session list, so it settles a Session reference with one exact read. */
    options?: Readonly<{ exactRead?: boolean }>): ApprovalReferenceReading {
    const serverId = reference?.kind === 'session' ? reference.serverId ?? approvalServerId : approvalServerId;
    const sessionReading = useApprovalSessionReading(reference?.kind === 'session' ? serverId : null,
        reference?.kind === 'session' ? reference.id : '', undefined, options);
    const viewer = useAccountSettingsScope();
    const ownHome = areServerProfileIdentifiersEquivalent(viewer?.serverId, approvalServerId);
    const artifact = useArtifact((reference?.kind === 'skill' || reference?.kind === 'artifact') && ownHome ? reference.id : '');
    const machine = useServerScopedMachine(approvalServerId, reference?.kind === 'machine' ? reference.id : '');
    const sessionMachine = useServerScopedMachine(serverId, reference?.kind === 'session' ? sessionReading.machineId : '');
    const mcp = useMcpServerCatalogForServer(reference?.kind === 'mcpServer' ? approvalServerId : null, reference?.kind === 'mcpServer');
    const registries = usePromptLibraryCatalogValue('registry-sources', reference?.kind === 'registrySource' && ownHome ? viewer : null);
    const project = useProjectAccountRows(rows => readApprovalProject(reference, rows, viewer, approvalServerId),
        reference?.kind === 'project' && ownHome);
    const projectCensusComplete = useProjectAccountRows(rows => rows?.status === 'ready' && rows.coverage === 'complete',
        reference?.kind === 'workspaceSyncRelationship');
    const agents = useAgentCatalogIdentities({ agentIds: reference?.kind === 'agent' ? [reference.id] : [], machineId: null,
        serverId: reference?.kind === 'agent' ? approvalServerId : null });
    const providerConnectionId = reference?.kind === 'providerConnection' ? reference.id
        : reference?.kind === 'providerModel' ? reference.connectionId : null;
    const providerCatalog = useProviderCatalogForServer(providerConnectionId ? approvalServerId : null);
    const teamCatalog = useHomeTeamCredentialModelCatalog({ serverId: approvalServerId,
        machineId: null,
        agentTargetKey: reference?.kind === 'providerConnection' || reference?.kind === 'providerModel' ? reference.agentTargetKey : null,
        enabled: Boolean(providerConnectionId && !providerCatalog?.data?.connections.some(row => row.id === providerConnectionId)) });
    const declarations = readAccountProviderDeclarations({ kind: 'account' });
    const syncLink = useWorkspaceSyncRelationshipSummary(reference?.kind === 'workspaceSyncRelationship' ? reference.id : null, approvalServerId ?? undefined);
    const workspaceRefId = reference?.kind === 'workspace' ? reference.id : null;
    const workspaceRef = useProjectAccountWorkspaceRef(workspaceRefId, approvalServerId ?? undefined);
    const workspaceMachineId = workspaceRef?.machineId ?? '';
    const workspaceMachineNames = useMachineDisplayNamesById(workspaceMachineId ? [workspaceMachineId] : []);
    const workspace = workspaceRefId ? endpointFor(workspaceRefId, workspaceRef ? [workspaceRef] : [], workspaceMachineNames, approvalServerId ?? undefined) : null;
    const { managedMachine, managedEnrolledMachine, managedMachineLoading } = useManagedReferenceSources(reference, approvalServerId);
    const connectedAccountTargets = React.useMemo((): readonly ProjectedQualifiedConnectedAccountTarget[] => {
        const service = reference?.kind === 'connectedAccount' ? parseQualifiedPluginContributionKey(reference.service) : null;
        if (reference?.kind !== 'connectedAccount' || !service) return [];
        return [{ key: CONNECTED_ACCOUNT_KEY, target: reference.pool
            ? { kind: 'group', service, groupId: reference.id }
            : { kind: 'account', account: { service, accountId: reference.id } } }];
    }, [reference]);
    const connectedAccount = useProjectedQualifiedConnectedAccountTargetPresentations(approvalServerId, connectedAccountTargets)
        .presentationsByKey[CONNECTED_ACCOUNT_KEY];
    return resolveApprovalReferenceReading(reference, literal, approvalServerId, { serverId, sessionReading, viewer, ownHome, artifact, machine, connectedAccount,
        managedMachine, managedEnrolledMachine, managedMachineLoading, sessionMachine, mcp, registries, project, projectCensusComplete, agents, providerCatalog, declarations,
        syncLink, workspace, teamResources: teamCatalog.resources, teamNameById: teamCatalog.teamNameById,
        teamCatalogLoading: teamCatalog.condition?.reason === 'loading' });
}

/** The managed row and its enrolled Machine behind a managed reference, read in the reference's own Home. */
function useManagedReferenceSources(reference: ApprovalReference | undefined, approvalServerId: string | null) {
    const managedServerId = reference?.kind === 'managedMachine' && areServerProfileIdentifiersEquivalent(reference.homeId, approvalServerId)
        ? approvalServerId : null;
    const managed = useManagedMachineInventory(managedServerId ? [managedServerId] : [],
        reference?.kind === 'managedMachine' ? reference.id : undefined);
    const managedMachine = managedServerId ? managed.machinesByServerId[managedServerId]?.find(row =>
        reference?.kind === 'managedMachine' && row.id === reference.id && row.homeId === reference.homeId) : undefined;
    const managedEnrolledMachine = useServerScopedMachine(managedServerId, managedMachine?.enrolledMachineId ?? '');
    return { managedMachine, managedEnrolledMachine, managedMachineLoading: managed.loading };
}

/** The managed guest's name: its enrolled Machine's current display name, else the launch name it was created with. */
function readManagedMachineName(sources: Pick<ApprovalReferenceSources, 'managedMachine' | 'managedEnrolledMachine'>): string | undefined {
    return getMachineDisplayName(sources.managedEnrolledMachine) ?? sources.managedMachine?.launch.name.trim();
}

/**
 * The name of a managed guest by its managed id, for a surface about it that is not an approval (an Action
 * operation runs on the controller but concerns the guest). Null until the guest is read.
 */
export function useManagedMachineName(serverId: string | null, managedId: string | null): string | null {
    const homeId = serverId ? getServerProfileById(serverId)?.serverIdentityId : undefined;
    const sources = useManagedReferenceSources(homeId && managedId ? { kind: 'managedMachine', id: managedId, homeId } : undefined, serverId);
    return readManagedMachineName(sources) || null;
}

const CONNECTED_ACCOUNT_KEY = 'connectedAccount';

type ApprovalReferenceSources = {
    serverId: string | null;
    connectedAccount?: { accessibilityLabel: string };
    sessionReading: Pick<ReturnType<typeof useApprovalSessionReading>, 'name' | 'machineId' | 'status'>;
    viewer: ReturnType<typeof useAccountSettingsScope>;
    ownHome: boolean;
    artifact?: DecryptedArtifact | null;
    machine?: Machine | null;
    managedMachine?: ManagedMachineV1;
    managedEnrolledMachine?: Machine | null;
    managedMachineLoading?: boolean;
    sessionMachine?: Machine | null;
    mcp?: ReturnType<typeof useMcpServerCatalogForServer>;
    registries?: Pick<ReturnType<typeof usePromptLibraryCatalogValue<'registry-sources'>>, 'value'>;
    project?: ProjectOrganizationRow | null;
    projectCensusComplete?: boolean;
    agents?: ReturnType<typeof useAgentCatalogIdentities>;
    providerCatalog?: ReturnType<typeof useProviderCatalogForServer>;
    teamResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById?: Readonly<Record<string, string>>;
    teamCatalogLoading?: boolean;
    declarations: ReturnType<typeof readAccountProviderDeclarations>;
    syncLink?: WorkspaceSyncRelationshipSummary | null;
    workspace?: WorkspaceSyncRelationshipEndpoint | null;
};

function resolveApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null, sources: ApprovalReferenceSources): ApprovalReferenceReading {
    const { serverId, sessionReading, viewer, ownHome, artifact, machine, sessionMachine, mcp, registries, agents, providerCatalog, declarations } = sources;
    if (reference?.kind === 'managedMachine') {
        const title = readManagedMachineName(sources);
        return { text: title || t('contextBar.machine'), named: true, subject: 'managedMachine',
            ...(sources.managedMachineLoading && !title ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'skill' || reference?.kind === 'artifact') return readApprovalArtifactReference(reference, ownHome ? artifact : null);
    if (reference?.kind === 'machine') {
        const title = getMachineDisplayName(machine) ?? reference.id;
        // The row's own label already names the kind ("Machine"); the value is just its name.
        return { text: reference.workspaceRoot ? `${formatPathRelativeToHome(reference.workspaceRoot)} · ${title}` : title, named: Boolean(machine) };
    }
    if (reference?.kind === 'workspaceSyncRelationship') {
        const link = sources.syncLink;
        // The link reads as the two folders it joins, each with its machine: "repo · Studio → repo-copy · Laptop".
        return link ? { text: formatWorkspaceSyncRelationshipTitle({
            alphaLabel: describeApprovalWorkspaceEndpoint(link.alpha), betaLabel: describeApprovalWorkspaceEndpoint(link.beta),
            mode: link.relationship.mode }), named: true }
            // A link the complete census no longer lists is gone; until it is read, the id is not copy either.
            : sources.projectCensusComplete ? { text: t('approvals.linkRemoved'), named: true }
            : { text: t('common.loading'), named: true, resolving: true };
    }
    if (reference?.kind === 'workspace') {
        const endpoint = sources.workspace;
        return endpoint?.workspaceRef ? { text: describeApprovalWorkspaceEndpoint(endpoint), named: true } : { text: literal, named: false };
    }
    if (reference?.kind === 'mcpServer') {
        const server = mcp?.value?.servers.find(row => row.id === reference.id);
        return { text: server ? mcpServerDisplayName(server) : reference.id, named: Boolean(server) };
    }
    if (reference?.kind === 'registrySource') {
        const source = registries?.value?.sources.find(row => row.id === reference.id)
            ?? BUILT_IN_REGISTRY_SOURCES_V1.find(row => row.id === reference.id);
        return { text: source?.title ?? reference.id, named: Boolean(source) };
    }
    if (reference?.kind === 'project') {
        const title = sources.project?.value.label;
        return { text: title ?? reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'agent') {
        const title = agents?.map(row => row.entry.title).join(', ') ?? '';
        return { text: title || reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'setting') {
        const setting = builtInSettingUiDeclaration(reference.id);
        return { text: t(setting.titleKey), named: true };
    }
    if (reference?.kind === 'providerContribution') {
        const declaration = declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, reference.id));
        return { text: declaration?.definition.name ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'connectedAccount') {
        // "Service · account" from the one connected-account naming rule; until it is read, the generic name.
        return sources.connectedAccount ? { text: sources.connectedAccount.accessibilityLabel, named: true }
            : { text: t('connectedServices.fallbackName'), named: false };
    }
    if (reference?.kind === 'agentModel') {
        // The Agent catalog's own title for its model ("GPT-6 Luna"), as every Session surface reads it.
        const title = resolveRunNativeModelLabel(reference.agentTargetKey)(reference.id);
        return { text: title ?? reference.id, named: true };
    }
    if (reference?.kind === 'providerModel') {
        const resource = findApprovalProviderSource(reference, sources.teamResources);
        const model = resource?.providerModels.find(row => row.selection.agentTargetKey === reference.agentTargetKey
            && row.selection.modelId === reference.id);
        const connectionId = ProviderConnectionIdSchema.safeParse(reference.connectionId);
        const manual = connectionId.success
            ? providerCatalog?.data?.manualModelsByConnectionId[connectionId.data]?.find(row => row.id === reference.id) : undefined;
        return { text: model?.descriptor.name || manual?.name || reference.id, named: true };
    }
    if (reference?.kind === 'providerConnection') {
        const connection = providerCatalog?.data?.connections.find(row => row.id === reference.id);
        if (connection) {
            const sourceName = connection.source.kind === 'custom' ? connection.source.template.name
                : declarations.find(row => connection.source.kind === 'contribution'
                    && areProviderContributionKeysEqualV1(row.contributionKey, connection.source.contributionKey))?.definition.name;
            return { text: presentProviderConnectionIdentity({ ...connection,
                providerName: sourceName ?? t('common.unavailable') }).title, named: true };
        }
        const resource = findApprovalProviderSource(reference, sources.teamResources);
        if (!resource && !reference.displayName && (sources.teamCatalogLoading || providerCatalog?.status === 'loading')) {
            return { text: t('common.loading'), named: true, resolving: true };
        }
        return { text: resource
            ? [resource.displayName, sources.teamNameById?.[resource.teamId]].filter(Boolean).join(' · ')
            : reference.displayName ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'session') {
        if (sessionReading.status === 'resolving') return { text: t('common.loading'), named: false, resolving: true };
        const title = sessionReading.name ?? describeUnnamedApprovalSession(resolveApprovalHomeSentenceName(serverId));
        const session = sessionReading.status === 'ready' ? { session: { id: reference.id, serverId } } : {};
        if (reference.presentation !== 'destructive_target') return { text: title, named: true, ...session };
        const machineName = getMachineDisplayName(sessionMachine)
            ?? (sessionReading.machineId || t('common.unavailable'));
        return {
            text: `${title} · ${t('contextBar.machine')} ${machineName} · …${reference.id.slice(-8)}`,
            named: true,
            ...session,
        };
    }
    if (reference?.kind === 'home') {
        const home = resolveApprovalHomeName(reference.id)
            ?? (areServerProfileIdentifiersEquivalent(reference.id, approvalServerId) ? t('settingsAccount.thisHomeTitle') : null);
        return home === null ? { text: literal, named: false } : { text: home, named: true };
    }
    if (reference?.kind === 'account') {
        const own = viewer !== null && viewer.accountId === reference.id && areServerProfileIdentifiersEquivalent(viewer.serverId, approvalServerId);
        return own ? { text: t('accountDisplay.yours'), named: true } : { text: literal, named: false };
    }
    return { text: literal, named: false };
}

function findApprovalProviderSource(reference: Extract<ApprovalReference, { kind: 'providerConnection' | 'providerModel' }>,
    resources: readonly TeamCredentialResourceCatalogEntryV1[] = []) {
    const connectionId = reference.kind === 'providerConnection' ? reference.id : reference.connectionId;
    return resources.find(resource => resource.providerModels.some(row => row.confirmationSource?.connectionId === connectionId
        && (!reference.catalogSourceKey || row.confirmationSource.catalogSourceKey === reference.catalogSourceKey)));
}

function describeApprovalWorkspaceEndpoint(endpoint: WorkspaceSyncRelationshipEndpoint): string {
    return endpoint.machineName ? `${endpoint.name} · ${endpoint.machineName}` : endpoint.name;
}

