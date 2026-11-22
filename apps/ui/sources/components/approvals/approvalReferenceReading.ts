import * as React from 'react';
import { t } from '@/text';
import { readMachineDisplayNamesById, storage, useArtifact, useMachineDisplayNamesById, useProjectAccountRows, useServerScopedMachine, useMachineListForServer } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent, getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { areProviderContributionKeysEqualV1, parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { describeUnnamedApprovalSession, resolveApprovalHomeName, resolveApprovalHomeSentenceName } from './approvalRequesterLabels';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { projectMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { getProviderCatalogSnapshot, readProviderCatalogConnection, readProviderCatalogModel } from '@/sync/store/settings/providerCatalogSnapshot';
import { readSavedSecretCatalogName } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { useSavedSecretCatalogName } from '@/components/secrets/useSavedSecretCatalog';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readCurrentProjectAccountRows, useProjectAccountWorkspaceRef, type ProjectAccountRowsSnapshot, type ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import { useApprovalSessionReading } from './useApprovalSessionReading';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { useWorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { endpointFor, type WorkspaceSyncRelationshipEndpoint, type WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { formatWorkspaceSyncRelationshipTitle } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { createManagedMachineActionClient } from '@/sync/api/machines/managedMachineActions';
import { isManagedOpaquePresetMachineV1, type ManagedMachineFullV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { useProjectedQualifiedConnectedAccountTargetPresentations, type ProjectedQualifiedConnectedAccountTarget } from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readApprovalPrincipalName, useApprovalPrincipalName } from './approvalPrincipalReading';
import { useDiscussionTitleReadings } from '@/components/discussions/useDiscussionTitles';
import { readDiscussionTitle } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
type ApprovalReference = ApprovalActionReference;

export type ApprovalReferenceReading = Readonly<{ text: string; named: boolean; resolving?: boolean; subject?: 'managedMachine';
    /** What the row is called when the reference declares it (a Provider purpose slot's declared title); else the row keeps its own label. */
    label?: string;
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
        providerConnection: readProviderCatalogConnection(scope, reference.kind === 'providerConnection' ? reference.id
            : reference.kind === 'providerModel' ? reference.connectionId
            : reference.kind === 'connectedAccount' ? reference.purpose?.connectionId ?? '' : ''),
        providerManualModel: reference.kind === 'providerModel' ? readProviderCatalogModel(scope, reference.connectionId, reference.id) : null,
        providerCatalogLoading: getProviderCatalogSnapshot(scope)?.status === 'loading',
        savedSecret: reference.kind === 'savedSecret'
            ? readSavedSecretCatalogName(scope, reference.id) : undefined,
        workspace: reference.kind === 'workspace' ? readConfirmationWorkspace(reference.id, projects, scope, state) : null,
        discussionTitle: reference.kind === 'discussion' ? readDiscussionTitle({ serverId: account.serverId, discussionId: reference.id }) : null,
    };
    sources.principalName = await readApprovalPrincipalName(reference, scope, signal, () => { account.assertCurrent(); return true; });
    if (sources.principalName !== null) account.assertCurrent();
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
            const read = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                { homeId: reference.homeId, managedId: reference.id }, { signal });
            const { createManagedMachinePresetReadCustodyV1 } = await import('@/sync/ops/machines/managedMachinePresetCustody');
            const { openManagedMachineReadSnapshotsAtCustody } = await import('@/sync/ops/machines/machinePresetCollectionClient');
            const custody = createManagedMachinePresetReadCustodyV1({ account, signal });
            let machine: ManagedMachineV1 | undefined;
            try {
                [machine] = await openManagedMachineReadSnapshotsAtCustody([read], custody);
            } finally {
                await custody?.dispose();
            }
            if (machine && machine.id === reference.id && machine.homeId === reference.homeId) sources.managedMachine = machine;
        } catch {
            // A display reference may be unreadable; it never grants resource access.
        }
        account.assertCurrent();
        sources.managedEnrolledMachine = sources.managedMachine?.enrolledMachineId
            ? resolveServerScopedMachine(storage.getState(), account.serverId, sources.managedMachine.enrolledMachineId) : null;
    }
    return resolveApprovalReferenceReading(reference, reference.id, account.serverId, sources);
}

/** The confirmation's workspace, read from the invoking Account's census the way the approval page reads it. */
function readConfirmationWorkspace(workspaceRefId: string, rows: ProjectAccountRowsSnapshot | null,
    scope: Readonly<{ serverId: string; accountId: string }>, state: ReturnType<typeof storage.getState>): WorkspaceSyncRelationshipEndpoint {
    const refs = rows && rows.scope.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(rows.scope.serverId, scope.serverId) ? rows.workspaceRefs : [];
    const resolution = resolveWorkspaceRefById(refs, workspaceRefId, scope.serverId);
    const machineId = resolution.kind === 'resolved' ? resolution.ref.machineId : '';
    return endpointFor(workspaceRefId, refs, machineId ? readMachineDisplayNamesById(state, [machineId]) : {}, scope.serverId);
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
    // Same-named Machines (twenty "Build box"es) are told apart the way their picker tells them apart.
    const machineInventory = useMachineListForServer(approvalServerId ?? '', reference?.kind === 'machine' && Boolean(approvalServerId));
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
    // A purpose slot of an existing connection reads its Provider through that connection.
    const slotConnectionId = reference?.kind === 'connectedAccount' && !reference.purpose?.contributionKey ? reference.purpose?.connectionId ?? null : null;
    const catalogServerId = providerConnectionId || slotConnectionId ? approvalServerId : null;
    const providerConnection = useProviderCatalogForServer(catalogServerId,
        snapshot => readProviderCatalogConnection(snapshot?.scope, providerConnectionId ?? slotConnectionId ?? ''));
    const providerManualModel = useProviderCatalogForServer(catalogServerId,
        snapshot => reference?.kind === 'providerModel' ? readProviderCatalogModel(snapshot?.scope, reference.connectionId, reference.id) : null);
    const providerCatalogLoading = useProviderCatalogForServer(catalogServerId, snapshot => snapshot?.status === 'loading');
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
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
    // A Saved Secret reads by its name from the Account's catalog on its own Home; another Home's catalog is not read.
    const savedSecret = useSavedSecretCatalogName(reference?.kind === 'savedSecret' ? reference.id : null, ownHome ? viewer : null);
    const principal = useApprovalPrincipalName(reference, approvalServerId);
    const discussion = useApprovalDiscussionTitle(reference, approvalServerId);
    return resolveApprovalReferenceReading(reference, literal, approvalServerId, { serverId, sessionReading, viewer, ownHome, artifact, machine, machineInventory, connectedAccount, savedSecret,
        managedMachine, managedEnrolledMachine, managedMachineLoading, sessionMachine, mcp, registries, project, projectCensusComplete, agents,
        providerConnection, providerManualModel, providerCatalogLoading, declarations, localizePluginText,
        syncLink, workspace, discussionTitle: discussion.title, discussionTitleResolving: discussion.resolving, principalName: principal.name, principalResolving: principal.resolving });
}

const NO_DISCUSSION_IDS: readonly string[] = Object.freeze([]);

/** A Discussion reads by the title this Account can read, from the one shared Discussion repository. */
function useApprovalDiscussionTitle(reference: ApprovalReference | undefined, approvalServerId: string | null): Readonly<{ title: string | null; resolving: boolean }> {
    const discussionId = reference?.kind === 'discussion' && approvalServerId ? reference.id : null;
    // The repository is keyed by the Home's scope id; an approval may carry any of that Home's identifiers.
    const scopeServerId = discussionId && approvalServerId ? resolveServerProfileScopeIdForIdentifier(approvalServerId) : null;
    const address = React.useMemo(() => (scopeServerId ? { serverId: scopeServerId } : null), [scopeServerId]);
    const discussionIds = React.useMemo(() => (discussionId ? [discussionId] : NO_DISCUSSION_IDS), [discussionId]);
    const { titles, resolving } = useDiscussionTitleReadings({ address, discussionIds });
    return { title: discussionId ? titles.get(discussionId) ?? null : null, resolving: discussionId !== null && resolving.has(discussionId) };
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
    const fullMachine: ManagedMachineFullV1 | null = sources.managedMachine && !isManagedOpaquePresetMachineV1(sources.managedMachine)
        ? sources.managedMachine : null;
    return getSettledMachineDisplayName(sources.managedEnrolledMachine) ?? fullMachine?.launch.name.trim();
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
    principalName?: string | null;
    principalResolving?: boolean;
    connectedAccount?: { accessibilityLabel: string };
    savedSecret?: Readonly<{ name: string | null; resolving: boolean }>;
    sessionReading: Pick<ReturnType<typeof useApprovalSessionReading>, 'name' | 'machineId' | 'status'>;
    viewer: ReturnType<typeof useAccountSettingsScope>;
    ownHome: boolean;
    artifact?: DecryptedArtifact | null;
    machine?: Machine | null;
    /** The Home's Machines, so a name shared by several carries the suffix that tells this one apart. */
    machineInventory?: readonly Machine[] | null;
    managedMachine?: ManagedMachineV1;
    managedEnrolledMachine?: Machine | null;
    managedMachineLoading?: boolean;
    sessionMachine?: Machine | null;
    mcp?: ReturnType<typeof useMcpServerCatalogForServer>;
    registries?: Pick<ReturnType<typeof usePromptLibraryCatalogValue<'registry-sources'>>, 'value'>;
    project?: ProjectOrganizationRow | null;
    projectCensusComplete?: boolean;
    agents?: ReturnType<typeof useAgentCatalogIdentities>;
    providerConnection?: ReturnType<typeof readProviderCatalogConnection>;
    providerManualModel?: ReturnType<typeof readProviderCatalogModel>;
    providerCatalogLoading?: boolean;
    declarations: ReturnType<typeof readAccountProviderDeclarations>;
    /** Absent where no plugin projection is mounted (a confirmation read): a declared title then reads by its fallback. */
    localizePluginText?: PluginLocalizedTextResolver;
    syncLink?: WorkspaceSyncRelationshipSummary | null;
    workspace?: WorkspaceSyncRelationshipEndpoint | null;
    /** The Discussion's title as this Account reads it; null while it is not readable. */
    discussionTitle?: string | null;
    /** The title is still being read: the destination reads as loading, not unavailable. */
    discussionTitleResolving?: boolean;
};

function resolveApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null, sources: ApprovalReferenceSources): ApprovalReferenceReading {
    const { serverId, sessionReading, viewer, ownHome, artifact, machine, sessionMachine, mcp, registries, agents, declarations } = sources;
    if (reference?.kind === 'managedMachine') {
        const title = readManagedMachineName(sources);
        // The generic word stands in for a machine that could not be read; it is not a name, so a title never
        // takes it as its subject ("Delete managed machine · Machine").
        return { text: title || t('contextBar.machine'), named: Boolean(title), subject: 'managedMachine',
            ...(sources.managedMachineLoading && !title ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'skill' || reference?.kind === 'artifact') return readApprovalArtifactReference(reference, ownHome ? artifact : null);
    if (reference?.kind === 'machine') {
        // A machine whose details were never read has no name yet: the reference's own id stands in, unnamed.
        const name = getSettledMachineDisplayName(machine, sources.machineInventory ?? undefined);
        const title = name ?? reference.id;
        // The row's own label already names the kind ("Machine"); the value is just its name.
        return { text: reference.workspaceRoot ? `${formatPathRelativeToHome(reference.workspaceRoot)} · ${title}` : title, named: Boolean(name) };
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
        const label = reference.purpose ? readDeclaredPurposeTitle(reference.purpose, sources) : undefined;
        return sources.connectedAccount ? { text: sources.connectedAccount.accessibilityLabel, named: true, ...(label ? { label } : {}) }
            : { text: t('connectedServices.fallbackName'), named: false, ...(label ? { label } : {}) };
    }
    if (reference?.kind === 'savedSecret') {
        // Its name only, never its value; a secret the catalog no longer lists reads as unavailable, not as its id.
        const saved = sources.savedSecret;
        return saved?.name ? { text: saved.name, named: true }
            : saved?.resolving ? { text: t('common.loading'), named: true, resolving: true }
            : { text: t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'teamModel') {
        if (sources.principalName) return { text: `${reference.id} · ${sources.principalName}`, named: true };
        if (sources.principalResolving) return { text: t('common.loading'), named: false, resolving: true };
        return { text: reference.id, named: false };
    }
    if (reference?.kind === 'agentModel') {
        // The Agent catalog's own title for its model ("GPT-6 Luna"), as every Session surface reads it.
        const title = resolveRunNativeModelLabel(reference.agentTargetKey)(reference.id);
        return { text: title ?? reference.id, named: true };
    }
    if (reference?.kind === 'providerModel') {
        const manual = sources.providerManualModel;
        return { text: manual?.name || reference.id, named: true };
    }
    if (reference?.kind === 'providerConnection') {
        const connection = sources.providerConnection;
        if (connection) {
            const sourceName = connection.source.kind === 'custom' ? connection.source.template.name
                : declarations.find(row => connection.source.kind === 'contribution'
                    && areProviderContributionKeysEqualV1(row.contributionKey, connection.source.contributionKey))?.definition.name;
            return { text: presentProviderConnectionIdentity({ ...connection,
                providerName: sourceName ?? t('common.unavailable') }).title, named: true };
        }
        if (!reference.displayName && sources.providerCatalogLoading) {
            return { text: t('common.loading'), named: true, resolving: true };
        }
        return { text: reference.displayName ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'session') {
        if (sessionReading.status === 'resolving') return { text: t('common.loading'), named: false, resolving: true };
        const title = sessionReading.name ?? describeUnnamedApprovalSession(resolveApprovalHomeSentenceName(serverId));
        const session = sessionReading.status === 'ready' ? { session: { id: reference.id, serverId } } : {};
        if (reference.presentation !== 'destructive_target'
            || !readSessionRecordingVisibility()({ sessionId: reference.id, serverId })) return { text: title, named: true, ...session };
        const machineName = getSettledMachineDisplayName(sessionMachine)
            ?? (sessionReading.machineId || t('common.unavailable'));
        return {
            text: `${title} · ${t('contextBar.machine')} ${machineName} · …${reference.id.slice(-8)}`,
            named: true,
            ...session,
        };
    }
    if (reference?.kind === 'discussion') {
        // A destination this device cannot read yet never borrows its opaque id as a name (the id stays in Technical details).
        return sources.discussionTitle ? { text: sources.discussionTitle, named: true }
            : sources.discussionTitleResolving ? { text: t('common.loading'), named: false, resolving: true }
            : { text: t('common.unavailable'), named: false };
    }
    if (reference?.kind === 'home') {
        const home = resolveApprovalHomeName(reference.id)
            ?? (areServerProfileIdentifiersEquivalent(reference.id, approvalServerId) ? t('settingsAccount.thisHomeTitle') : null);
        return home === null ? { text: literal, named: false } : { text: home, named: true };
    }
    if (reference?.kind === 'account') {
        const own = viewer !== null && viewer.accountId === reference.id && areServerProfileIdentifiersEquivalent(viewer.serverId, approvalServerId);
        if (own) return { text: t('accountDisplay.yours'), named: true };
    }
    if (sources.principalName) return { text: sources.principalName, named: true };
    if (sources.principalResolving) return { text: t('common.loading'), named: false, resolving: true };
    return { text: literal, named: false };
}

/** A purpose slot's title as its Provider declares it, localized by the Provider's plugin; undefined when the declaration is not known. */
function readDeclaredPurposeTitle(purpose: NonNullable<Extract<ApprovalReference, { kind: 'connectedAccount' }>['purpose']>,
    sources: Pick<ApprovalReferenceSources, 'declarations' | 'providerConnection' | 'localizePluginText'>): string | undefined {
    const connection = purpose.connectionId ? sources.providerConnection : undefined;
    const contributionKey = purpose.contributionKey ?? (connection?.source.kind === 'contribution' ? connection.source.contributionKey : undefined);
    if (!contributionKey) return undefined;
    const declaration = sources.declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, contributionKey));
    const title = declaration?.definition.connectedAccounts?.find(row => row.purpose === purpose.id)?.title;
    if (!title) return undefined;
    const pluginId = parseProviderContributionIdentityV1(contributionKey)?.identity.pluginId ?? contributionKey;
    return (sources.localizePluginText?.(pluginId, title) ?? (typeof title === 'string' ? title : title.fallback)) || undefined;
}

function describeApprovalWorkspaceEndpoint(endpoint: WorkspaceSyncRelationshipEndpoint): string {
    return endpoint.machineName ? `${endpoint.name} · ${endpoint.machineName}` : endpoint.name;
}

