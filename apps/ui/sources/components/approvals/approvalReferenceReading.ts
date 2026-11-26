import * as React from 'react';
import { useArtifactTitleProjections } from '@/components/artifacts/useArtifactTitleProjections';
import { core } from 'zod/mini';
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
import { readBuiltInSettingUiIdentifierTitleKey } from '@/components/settings/catalog/settingDeclarations';
import { readVoiceSettingsDeclaration } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { readObservedTeamInvitation } from '@/hooks/teams/useTeamInvitations';
import { resolveTeamInvitationPresentation } from '@/components/settings/teams/invitations/teamInvitationPresentation';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { projectPrivateLabelForRecipientV1, type PrivateLabelReadV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { describeUnnamedApprovalSession, resolveApprovalHomeName, resolveApprovalHomeSentenceName } from './approvalRequesterLabels';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readApprovalProfileDescriptor } from '@/sync/engine/settings/approvalProfileCatalog';
import { useOpenedTeamCredentialDisplayNames } from '@/components/settings/teams/credentials/teamCredentialPrivateLabels';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readSignInIdentityName } from '@/sync/store/home/governance/homeGovernanceSnapshots';
import { createPrivateLabelClientForActionAccountContext, isPrivateLabelLifecycleFailureV1 } from '@/sync/ops/privateLabels/privateLabelClient';
import { useOpenedPrivateLabels } from '@/sync/ops/privateLabels/useOpenedPrivateLabels';
import { teamCredentialDisplayNameBinding, teamCredentialExternalApiKeyLabelBinding } from '@/sync/ops/teams/teamCredentialLabels';
import { readObservedTeamCredentialExternalKey, readObservedTeamCredentialLimit, readObservedTeamExternalGroupBinding, readTeamCredentialResourceApprovalProjection,
    readTeamDirectoryGroupName, readTeamDirectorySourceName, readTeamSetupStepName, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { limitMetricLabel, limitPeriodLabel, limitSubjectLine } from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { openTeamGroupLabelProjection, openTeamGroupNameProjection } from '@/sync/ops/teams/teamGroupLabels';
import { readHomeSetupStepTitle } from '@/components/hub/setup/homeSetupStepTitles';
import { approvalProfileDefaultNoneTitle } from './approvalProfileDefaultChoiceCopy';
import { useScopedSharingRead } from '@/components/sharing/sharePrincipalNames';
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
import { createMachinePresetActionClient } from '@/sync/api/machines/managedMachinePresets';
import { createMachinePoolActionClient } from '@/sync/api/machines/machinePoolActions';
import { createMachinePoolPrivateLabelClientForAccount, openMachinePoolPrivateLabelV1,
    readMachinePoolPrivateNameV1 } from '@/sync/ops/machinePoolPrivateLabelProjection';
import { isManagedOpaquePresetMachineV1, type ManagedMachineFullV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { useProjectedQualifiedConnectedAccountTargetPresentations, type ProjectedQualifiedConnectedAccountTarget } from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readApprovalPrincipalName, useApprovalPrincipalName } from './approvalPrincipalReading';
import { useDiscussionTitleReadings } from '@/components/discussions/useDiscussionTitles';
import { readDiscussionTitle } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { useHomeHubLayoutReading } from '@/components/hub/layout/useHomeHubLayout';
import { homeChildTitle, homeHubSectionTitle } from '@/components/hub/homeHubSections';
import { useWorkflowReferenceTitleRead } from '@/components/workflows/presentation/workflowReferenceOptions';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { useActiveServerAccountScopeLifetime, useWorkflowRun } from '@/sync/store/hooks';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { describeWidgetGroupAmong } from '@/components/widgets/group/widgetGroupMenu';
type ApprovalReference = ApprovalActionReference;

export type ApprovalReferenceReading = Readonly<{ text: string; named: boolean; resolving?: boolean; subject?: 'managedMachine';
    /** What the row is called when the reference declares it (a Provider purpose slot's declared title); else the row keeps its own label. */
    label?: string;
    /** A Session this device read: the reference opens it. */
    session?: Readonly<{ id: string; serverId: string | null }> }>;

/** Both cached UI rows and authorized exact reads use the same content-readable name rule. */
function readApprovalArtifactReference(reference: Extract<ApprovalReference, { kind: 'artifact' | 'skill' }>,
    artifact: DecryptedArtifact | null | undefined): ApprovalReferenceReading {
    const { kind, id, unavailableWithoutName } = reference;
    const readable = artifact?.isDecrypted === true && (kind === 'artifact'
        || kind === 'skill' && artifact.header?.kind === 'prompt_bundle.v2'
            && artifact.header.bundleSchemaId === 'skills.skill_md_v1');
    const title = readable ? artifact.title?.trim() || artifact.header?.title?.trim() : null;
    return { text: title || (unavailableWithoutName ? t('common.unavailable') : id), named: Boolean(title) };
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
        machine: reference.kind === 'machine' && (!reference.serverId
            || areServerProfileIdentifiersEquivalent(reference.serverId, account.serverId))
            ? resolveServerScopedMachine(state, account.serverId, reference.id) : null,
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
    let principal: ApprovalReference | undefined = reference;
    if (reference.kind === 'teamCredentialAudience') {
        account.assertCurrent();
        principal = credentialAudiencePrincipal(reference, readTeamCredentialResourceApprovalProjection(scope, reference.resourceId)?.teamId);
    }
    sources.principalName = await readApprovalPrincipalName(principal, scope, signal, () => { account.assertCurrent(); return true; });
    if (sources.principalName !== null) account.assertCurrent();
    if (reference.kind === 'approvalProfile' && reference.id !== null) {
        try {
            sources.approvalProfileName = (await readApprovalProfileDescriptor(account, reference.id, signal))?.name;
        } catch {
            // Missing display metadata does not change what may be approved.
        }
        account.assertCurrent();
    }
    if (reference.kind === 'machinePreset' || reference.kind === 'machinePool') {
        sources.machineCatalogName = await readMachineCatalogReferenceName(reference, account, signal);
        account.assertCurrent();
    }
    if (reference.kind === 'privateLabel') {
        sources.privateLabelName = await readApprovalPrivateLabel(reference, account, signal);
        account.assertCurrent();
    }
    if (reference.kind === 'teamCredentialResource') {
        try {
            sources.teamCredentialResourceName = await createPrivateLabelClientForActionAccountContext(account).open({
                binding: teamCredentialDisplayNameBinding(reference.id),
                label: readTeamCredentialResourceApprovalProjection(scope, reference.id)?.displayName ?? null,
                readPolicy: { kind: 'team-resource' },
                signal,
            });
        } catch {
            // Unopened labels retain the same unavailable reading as missing projections.
        }
        account.assertCurrent();
    }
    if (reference.kind === 'teamCredentialExternalKey') {
        const teamId = readTeamCredentialResourceApprovalProjection(scope, reference.resourceId)?.teamId;
        const label = teamId ? readObservedTeamCredentialExternalKey(scope, teamId, reference.resourceId, reference.id)?.label : null;
        if (label) {
            try {
                sources.teamCredentialExternalKeyName = await createPrivateLabelClientForActionAccountContext(account).open({
                    binding: teamCredentialExternalApiKeyLabelBinding(reference.id), label, readPolicy: { kind: 'team-resource' }, signal,
                });
            } catch {
                // A missing or unreadable projection keeps the ordinary unavailable reading.
            }
            account.assertCurrent();
        }
    }
    if (reference.kind === 'signInConnection' || reference.kind === 'signInProvider') {
        account.assertCurrent();
        sources.signInIdentityName = readSignInIdentityName(scope, reference);
    }
    if (reference.kind === 'teamDirectorySource') {
        account.assertCurrent();
        sources.teamDirectorySourceName = readTeamDirectorySourceName(scope, reference.teamId, reference.id);
    }
    if (isTeamDomainReference(reference)) {
        sources.teamDomainName = await readTeamDomainReference(reference, account, signal);
        account.assertCurrent();
    }
    if (reference.kind === 'homeSetupStep') sources.homeSetupStepName = readSetupStepName(reference.id, scope);
    if (reference.kind === 'teamInvitation') {
        account.assertCurrent();
        sources.teamInvitationName = readTeamInvitationName(scope, reference);
    }
    if (reference.kind === 'artifact' || reference.kind === 'skill') {
        sources.artifact = await account.fetchArtifact(reference.id, { signal });
        account.assertCurrent();
    }
    if (reference.kind === 'mcpServer') {
        const snapshot = await readMcpServerCatalogInContext(account, signal);
        account.assertCurrent();
        sources.mcp = projectMcpServerCatalogSnapshot(snapshot);
    }
    const managedHomeId = reference.kind === 'managedMachine' ? reference.homeId ?? account.serverIdentityId : null;
    if (reference.kind === 'managedMachine' && managedHomeId && managedHomeId === account.serverIdentityId) {
        try {
            account.assertCurrent();
            const read = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get',
                { homeId: managedHomeId, managedId: reference.id }, { signal });
            const { createManagedMachinePresetReadCustodyV1 } = await import('@/sync/ops/machines/managedMachinePresetCustody');
            const { openManagedMachineReadSnapshotsAtCustody } = await import('@/sync/ops/machines/machinePresetCollectionClient');
            const custody = createManagedMachinePresetReadCustodyV1({ account, signal });
            let machine: ManagedMachineV1 | undefined;
            try {
                [machine] = await openManagedMachineReadSnapshotsAtCustody([read], custody);
            } finally {
                await custody?.dispose();
            }
            if (machine && machine.id === reference.id && machine.homeId === managedHomeId) sources.managedMachine = machine;
        } catch {
            // A display reference may be unreadable; it never grants resource access.
        }
        account.assertCurrent();
        sources.managedEnrolledMachine = sources.managedMachine?.enrolledMachineId
            ? resolveServerScopedMachine(storage.getState(), account.serverId, sources.managedMachine.enrolledMachineId) : null;
    }
    return resolveApprovalReferenceReading(reference, reference.id ?? '', account.serverId, sources);
}

type MachineCatalogReference = Extract<ApprovalReference, { kind: 'machinePreset' | 'machinePool' }>;

type TeamDomainReference = Extract<ApprovalReference, {
    kind: 'teamDirectoryGroup' | 'teamExternalGroupBinding' | 'teamCredentialLimit';
}>;

function isTeamDomainReference(reference: ApprovalReference | undefined): reference is TeamDomainReference {
    return reference?.kind === 'teamDirectoryGroup' || reference?.kind === 'teamExternalGroupBinding'
        || reference?.kind === 'teamCredentialLimit';
}

function readSetupStepName(id: string, scope: ApprovalReferenceSources['viewer']): string | null {
    const builtIn = readHomeSetupStepTitle(id);
    if (builtIn || !scope) return builtIn;
    const team = readTeamSetupStepName(scope, id);
    return team ? t('homeSetup.teamSetupTitle', { team }) : null;
}

async function readTeamDomainReference(reference: TeamDomainReference, account: LazyActionAccountContext,
    signal?: AbortSignal): Promise<string | null> {
    account.assertCurrent();
    const scope = { serverId: account.serverId, accountId: account.accountId };
    if (reference.kind === 'teamDirectoryGroup') {
        return reference.sourceId ? readTeamDirectoryGroupName(scope, reference.teamId, reference.sourceId, reference.id) : null;
    }
    if (reference.kind === 'teamExternalGroupBinding') {
        const row = readObservedTeamExternalGroupBinding(scope, reference.teamId, reference.id);
        if (!row) return null;
        if (row.kind === 'directoryGroup') return row.displayName;
        const targetName = await openTeamGroupNameProjection({
            client: createPrivateLabelClientForActionAccountContext(account),
            groupId: row.target.teamGroupId, name: row.target.name, signal,
        });
        return targetName ? `${t('identityAdministration.mappedTo')} · ${targetName}` : null;
    }
    const { resourceId, resourceRevision, id } = reference;
    const limit = readObservedTeamCredentialLimit(scope, resourceId, resourceRevision, id);
    if (!limit) return null;
    const teamId = limit.subjectKind === 'team_group' ? readTeamCredentialResourceApprovalProjection(scope, resourceId)?.teamId : null;
    const principal = limit.subjectKind === 'team_member' ? { kind: 'account' as const, id: limit.subjectId }
        : teamId ? { kind: 'group' as const, id: limit.subjectId, teamId } : undefined;
    const subjectName = await readApprovalPrincipalName(principal, scope, signal, () => { account.assertCurrent(); return true; });
    account.assertCurrent();
    return [limitSubjectLine(limit, () => subjectName), limitMetricLabel(limit.metric), limitPeriodLabel(limit.period), limit.maximum].join(' · ');
}

type PrivateLabelReference = Extract<ApprovalReference, { kind: 'privateLabel' }>;

async function readExactPoolForApproval(id: string, account: LazyActionAccountContext, signal?: AbortSignal) {
    const view = await createMachinePoolActionClient({ request: account.request }).execute('machines.pools.get',
        { poolId: id }, { serverId: account.serverId, signal });
    return view.pool.id === id ? view : null;
}

async function readApprovalPrivateLabel(reference: PrivateLabelReference, account: LazyActionAccountContext,
    signal?: AbortSignal): Promise<string | null> {
    const { owner, id, field } = reference;
    let label: PrivateLabelReadV1;
    try {
        label = projectPrivateLabelForRecipientV1({ stored: reference.stored, recipientAccountId: account.accountId });
    } catch (error) {
        if (!(error instanceof core.$ZodError)) throw error;
        return null;
    }
    if (owner === 'teamGroup') {
        const client = createPrivateLabelClientForActionAccountContext(account);
        try {
            return await openTeamGroupLabelProjection({ client, groupId: id, field, label, signal });
        } catch (error) {
            if (isPrivateLabelLifecycleFailureV1(error, signal)) throw error;
            return null;
        }
    }
    const labels = createMachinePoolPrivateLabelClientForAccount(account);
    const retained = typeof owner === 'object' ? await readExactPoolForApproval(id, account, signal) : null;
    if (typeof owner === 'object' && retained?.pool.revision !== owner.expectedRevision) return null;
    const readPolicy = retained ? await labels.readPolicyForPool(retained, signal)
        : await labels.readPolicyForAudience(owner === 'teamPool' ? 'team' : 'private', signal);
    const opened = await openMachinePoolPrivateLabelV1({ poolId: id, field, label: { kind: 'available', label }, labels,
        readPolicy, signal });
    return opened.kind === 'available' ? opened.value : null;
}

async function readMachineCatalogReferenceName(reference: MachineCatalogReference, account: LazyActionAccountContext,
    signal?: AbortSignal): Promise<string | null> {
    try {
        if (reference.kind === 'machinePool') {
            const view = await readExactPoolForApproval(reference.id, account, signal);
            if (!view) return null;
            return await readMachinePoolPrivateNameV1({ view, labels: createMachinePoolPrivateLabelClientForAccount(account), signal });
        }
        const homeId = reference.homeId ?? account.serverIdentityId;
        if (!homeId || homeId !== account.serverIdentityId) return null;
        const found = await createMachinePresetActionClient({ request: account.request }).execute('machines.presets.get',
            { homeId, id: reference.id }, { signal });
        if (found.kind !== 'found' || found.preset.id !== reference.id || found.preset.homeId !== homeId) return null;
        const { createManagedMachinePresetReadCustodyV1 } = await import('@/sync/ops/machines/managedMachinePresetCustody');
        const { openStoredMachinePresetAtCustody } = await import('@/sync/ops/machines/machinePresetCollectionClient');
        const custody = createManagedMachinePresetReadCustodyV1({ account, signal });
        try {
            const preset = await openStoredMachinePresetAtCustody(found.preset, async () => custody);
            return preset && typeof preset !== 'string' ? preset.name : null;
        } finally {
            await custody?.dispose();
        }
    } catch {
        return null;
    }
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

/** A Home approval can name only items from the viewing Account's captured Home. */
export function useApprovalHomeLayoutItemReading(approvalServerId: string | null, viewerServerId?: string) {
    const ownHome = areServerProfileIdentifiersEquivalent(viewerServerId, approvalServerId);
    const layout = useHomeHubLayoutReading(ownHome);
    const sections = ownHome ? layout.sections.flatMap(section => section.kind === 'group' ? [section, ...section.children] : [section]) : [];
    return {
        resolving: ownHome && layout.status === 'loading',
        readName: (id: string): string | null => {
            const section = sections.find(candidate => candidate.id === id);
            if (!section) return null;
            return section.kind === 'group'
                ? describeWidgetGroupAmong(layout.items, section.group, homeChildTitle(layout.sections))
                : homeHubSectionTitle(section);
        },
    };
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
    // A Document this Account can open names itself on a cold page: the one exact demand Doc labels use opens it.
    const artifactRefs = React.useMemo(() => (reference?.kind === 'skill' || reference?.kind === 'artifact') && ownHome
        ? [reference.id] : NO_ARTIFACT_REFS, [ownHome, reference]);
    const artifactTitles = useArtifactTitleProjections(viewer, artifactRefs, artifactRefs.length > 0);
    const machineReference = reference?.kind === 'machine' && (!reference.serverId
        || areServerProfileIdentifiersEquivalent(reference.serverId, approvalServerId)) ? reference : null;
    const machine = useServerScopedMachine(approvalServerId, machineReference?.id ?? '');
    // Same-named Machines (twenty "Build box"es) are told apart the way their picker tells them apart.
    const machineInventory = useMachineListForServer(approvalServerId ?? '', Boolean(machineReference && approvalServerId));
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
    const credentialAudience = reference?.kind === 'teamCredentialAudience' ? reference : null;
    const credentialKey = reference?.kind === 'teamCredentialExternalKey' ? reference : null;
    const credentialResourceId = credentialAudience?.resourceId ?? credentialKey?.resourceId
        ?? (reference?.kind === 'teamCredentialResource' ? reference.id : null);
    const credentialProjection = useApprovalTeamCredentialResource(credentialResourceId, approvalServerId);
    const principal = useApprovalPrincipalName(credentialAudience
        ? credentialAudiencePrincipal(credentialAudience, credentialProjection.resource?.teamId) : reference, approvalServerId);
    const profileId = reference?.kind === 'approvalProfile' ? reference.id : null;
    const machineCatalogReference = reference?.kind === 'machinePreset' || reference?.kind === 'machinePool' ? reference : null;
    const teamReference = isTeamDomainReference(reference) ? reference : null;
    const privateLabel = reference?.kind === 'privateLabel' ? reference : null;
    const lookupKey = privateLabel ? JSON.stringify(privateLabel) : machineCatalogReference ? JSON.stringify([machineCatalogReference.kind,
        machineCatalogReference.id, machineCatalogReference.kind === 'machinePreset' && machineCatalogReference.homeId])
        : teamReference ? JSON.stringify(teamReference) : profileId === null ? null : JSON.stringify(['approvalProfile', profileId]);
    const lookup = useScopedSharingRead(lookupKey, approvalServerId, async (scope, signal) => {
        const account = await captureLazyActionAccountContext(scope.serverId, signal);
        try {
            if (account.accountId !== scope.accountId) return null;
            if (privateLabel) return await readApprovalPrivateLabel(privateLabel, account, signal);
            if (teamReference) return await readTeamDomainReference(teamReference, account, signal);
            return machineCatalogReference ? await readMachineCatalogReferenceName(machineCatalogReference, account, signal)
                : profileId === null ? null : (await readApprovalProfileDescriptor(account, profileId, signal))?.name ?? null;
        } finally {
            account.dispose();
        }
    });
    const discussion = useApprovalDiscussionTitle(reference, approvalServerId);
    const teamCredentialResourceName = useApprovalTeamCredentialResourceName(
        reference?.kind === 'teamCredentialResource' ? reference.id : null, credentialProjection);
    const keyId = credentialKey?.id;
    const keyTeamId = credentialProjection.resource?.teamId;
    const keyLabel = credentialKey && keyTeamId && credentialProjection.scope
        ? readObservedTeamCredentialExternalKey(credentialProjection.scope, keyTeamId, credentialKey.resourceId, credentialKey.id)?.label : null;
    const keyLabelRequests = React.useMemo(() => keyId && keyLabel ? [{ key: keyId, label: keyLabel,
        binding: teamCredentialExternalApiKeyLabelBinding(keyId), readPolicy: { kind: 'team-resource' as const } }] : [], [keyId, keyLabel]);
    const openedKeyLabels = useOpenedPrivateLabels({ scope: credentialProjection.scope, requests: keyLabelRequests });
    const teamCredentialExternalKeyName = keyId && keyLabel ? openedKeyLabels[keyId] ?? null : null;
    const signInReference = reference?.kind === 'signInConnection' || reference?.kind === 'signInProvider' ? reference : null;
    const directorySource = reference?.kind === 'teamDirectorySource' ? reference : null;
    const invitation = reference?.kind === 'teamInvitation' ? reference : null;
    const governanceBinding = useServerCredentialAccountScopeBinding(signInReference || directorySource || invitation ? approvalServerId : null).binding;
    const governanceScope = governanceBinding?.isCurrent() ? governanceBinding.scope : null;
    const signInIdentityName = signInReference && governanceScope ? readSignInIdentityName(governanceScope, signInReference) : null;
    const teamDirectorySourceName = directorySource && governanceScope
        ? readTeamDirectorySourceName(governanceScope, directorySource.teamId, directorySource.id) : null;
    const teamInvitationName = invitation && governanceScope ? readTeamInvitationName(governanceScope, invitation) : null;
    const workflowRefs = React.useMemo(() => reference?.kind === 'workflow' && ownHome ? [reference.id] : NO_WORKFLOW_REFS,
        [ownHome, reference]);
    const workflowTitles = useWorkflowReferenceTitleRead(workflowRefs, workflowRefs.length > 0);
    const workflowRun = useApprovalWorkflowRun(reference?.kind === 'workflowRun' && ownHome ? reference.id : null);
    const homeLayout = useApprovalHomeLayoutItemReading(reference?.kind === 'homeLayoutItem' ? approvalServerId : null, viewer?.serverId);
    const homeLayoutItemName = reference?.kind === 'homeLayoutItem' ? homeLayout.readName(reference.id) : null;
    return resolveApprovalReferenceReading(reference, literal, approvalServerId, { serverId, sessionReading, viewer, ownHome, artifact, artifactResolving: artifactRefs.length > 0 && artifactTitles[0] === undefined, machine, machineInventory, connectedAccount, savedSecret,
        managedMachine, managedEnrolledMachine, managedMachineLoading, sessionMachine, mcp, registries, project, projectCensusComplete, agents,
        providerConnection, providerManualModel, providerCatalogLoading, declarations, localizePluginText,
        syncLink, workspace, discussionTitle: discussion.title, discussionTitleResolving: discussion.resolving,
        principalName: principal.name, principalResolving: principal.resolving,
        approvalProfileName: profileId === null ? undefined : lookup.value ?? undefined,
        approvalProfileResolving: profileId !== null && lookup.resolving,
        teamCredentialResourceName, teamCredentialExternalKeyName, signInIdentityName, teamDirectorySourceName, teamInvitationName, homeLayoutItemName,
        privateLabelName: privateLabel ? lookup.value : null,
        privateLabelResolving: privateLabel !== null && lookup.resolving,
        teamDomainName: teamReference ? lookup.value : null,
        teamDomainResolving: teamReference !== null && lookup.resolving,
        homeSetupStepName: reference?.kind === 'homeSetupStep' ? readSetupStepName(reference.id, ownHome ? viewer : null) : null,
        homeLayoutItemResolving: reference?.kind === 'homeLayoutItem' && homeLayout.resolving,
        machineCatalogName: machineCatalogReference ? lookup.value : null,
        machineCatalogResolving: machineCatalogReference !== null && lookup.resolving,
        workflowTitle: workflowRefs[0] ? workflowTitles.title(workflowRefs[0]) : null,
        workflowTitleResolving: workflowRefs[0] ? workflowTitles.isPending(workflowRefs[0]) : false,
        workflowRunName: workflowRun.text, workflowRunResolving: workflowRun.resolving });
}

const NO_WORKFLOW_REFS: readonly string[] = Object.freeze([]);
const NO_ARTIFACT_REFS: readonly string[] = Object.freeze([]);

/**
 * An existing Run reads as its Run rows do: its Workflow's title from the Run label owner and when it started, on
 * the shared list clock. A Run this device has not read yet gets one exact read through the Run owner.
 */
function useApprovalWorkflowRun(runId: string | null): Readonly<{ text: string | null; resolving: boolean }> {
    const lifetime = useActiveServerAccountScopeLifetime(runId !== null);
    const row = useWorkflowRun(runId, { enabled: runId !== null, ...(lifetime ? { scope: lifetime.scope } : {}) });
    const missing = runId !== null && row === null;
    const [settledRunId, setSettledRunId] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!runId || !missing || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        void refreshWorkflowRunById(runId, { signal: controller.signal, fence: lifetime, accountLifetime: lifetime })
            .catch(() => {}).finally(() => { if (!controller.signal.aborted) setSettledRunId(runId); });
        return () => controller.abort();
    }, [lifetime, missing, runId]);
    const startedAt = row?.summary ? Date.parse(row.summary.createdAt) : Number.NaN;
    const started = Number.isFinite(startedAt);
    const readNextRefresh = React.useCallback((nowMs: number) => started ? readRelativeTimeShortRefreshAtMs(startedAt, nowMs) : null,
        [started, startedAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, started);
    if (!runId) return { text: null, resolving: false };
    if (!row) return { text: null, resolving: settledRunId !== runId };
    const name = formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata));
    return { text: started ? `${name} · ${formatRelativeTimeShort(startedAt, nowMs)}` : name, resolving: false };
}

function readTeamInvitationName(scope: NonNullable<ApprovalReferenceSources['viewer']>,
    reference: Extract<ApprovalReference, { kind: 'teamInvitation' }>): string | null {
    const invitation = readObservedTeamInvitation(scope, reference.teamId, reference.id);
    return invitation ? resolveTeamInvitationPresentation(invitation, Date.now(), scope.accountId).title : null;
}

const NO_DISCUSSION_IDS: readonly string[] = Object.freeze([]);

function credentialAudiencePrincipal(
    reference: Extract<ApprovalReference, { kind: 'teamCredentialAudience' }>,
    teamId: string | undefined,
): ApprovalReference | undefined {
    if (!teamId) return undefined;
    return reference.audience === 'group'
        ? { kind: 'group', id: reference.id, teamId }
        : { kind: 'teamMembership', id: reference.id, teamId };
}

function useApprovalTeamCredentialResource(resourceId: string | null, approvalServerId: string | null) {
    const { binding } = useServerCredentialAccountScopeBinding(resourceId ? approvalServerId : null);
    const scope = binding?.scope ?? null;
    const subscribe = React.useCallback((listener: () => void) => scope && resourceId
        ? subscribeTeamsSnapshots(listener) : () => {}, [scope, resourceId]);
    const read = React.useCallback(() => binding?.isCurrent() && resourceId
        ? readTeamCredentialResourceApprovalProjection(binding.scope, resourceId) : null, [binding, resourceId]);
    const resource = React.useSyncExternalStore(subscribe, read, read);
    return { scope, resource };
}

function useApprovalTeamCredentialResourceName(
    resourceId: string | null,
    { scope, resource }: ReturnType<typeof useApprovalTeamCredentialResource>,
): string | null {
    const label = resource?.displayName;
    const resources = React.useMemo(() => resourceId && label ? [{ id: resourceId, displayName: label }] : [],
        [resourceId, label]);
    const opened = useOpenedTeamCredentialDisplayNames({ scope, resources });
    return label && resourceId ? opened[resourceId] ?? null : null;
}

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
    const managedServerId = reference?.kind === 'managedMachine'
        && (!reference.homeId || areServerProfileIdentifiersEquivalent(reference.homeId, approvalServerId))
        ? approvalServerId : null;
    const managedHomeId = reference?.kind === 'managedMachine' && managedServerId
        ? reference.homeId ?? getServerProfileById(managedServerId)?.serverIdentityId : undefined;
    const managed = useManagedMachineInventory(managedServerId ? [managedServerId] : [],
        reference?.kind === 'managedMachine' ? reference.id : undefined);
    const managedMachine = managedServerId ? managed.machinesByServerId[managedServerId]?.find(row =>
        reference?.kind === 'managedMachine' && row.id === reference.id && row.homeId === managedHomeId) : undefined;
    const managedEnrolledMachine = useServerScopedMachine(managedServerId, managedMachine?.enrolledMachineId ?? '');
    return { managedMachine, managedEnrolledMachine, managedMachineLoading: managed.loading };
}

/** The managed guest's name: its enrolled Machine's current display name, else the launch name it was created with. */
function readManagedMachineName(sources: Pick<ApprovalReferenceSources, 'managedMachine' | 'managedEnrolledMachine'>): string | undefined {
    return getSettledMachineDisplayName(sources.managedEnrolledMachine) ?? readManagedLaunchName(sources.managedMachine);
}

/** The name a managed resource was created or attached with; an opaque preset row carries none. */
export function readManagedLaunchName(machine: ManagedMachineV1 | undefined): string | undefined {
    const fullMachine: ManagedMachineFullV1 | null = machine && !isManagedOpaquePresetMachineV1(machine) ? machine : null;
    return fullMachine?.launch.name.trim() || undefined;
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
    artifactResolving?: boolean;
    serverId: string | null;
    principalName?: string | null;
    principalResolving?: boolean;
    approvalProfileName?: string;
    approvalProfileResolving?: boolean;
    teamCredentialResourceName?: string | null;
    teamCredentialExternalKeyName?: string | null;
    signInIdentityName?: string | null;
    teamDirectorySourceName?: string | null;
    privateLabelName?: string | null;
    privateLabelResolving?: boolean;
    teamDomainName?: string | null;
    teamDomainResolving?: boolean;
    homeSetupStepName?: string | null;
    teamInvitationName?: string | null;
    homeLayoutItemName?: string | null;
    homeLayoutItemResolving?: boolean;
    machineCatalogName?: string | null;
    machineCatalogResolving?: boolean;
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
    workflowTitle?: string | null;
    workflowTitleResolving?: boolean;
    /** The Run's Workflow title and start time, as its Run rows read it. */
    workflowRunName?: string | null;
    workflowRunResolving?: boolean;
};

function resolveApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null, sources: ApprovalReferenceSources): ApprovalReferenceReading {
    const { serverId, sessionReading, viewer, ownHome, artifact, machine, sessionMachine, mcp, registries, agents, declarations } = sources;
    if (reference?.kind === 'homeLayoutItem') {
        const name = sources.homeLayoutItemName;
        return { text: name ?? t(sources.homeLayoutItemResolving ? 'common.loading' : 'common.unavailable'),
            named: Boolean(name), ...(sources.homeLayoutItemResolving ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'teamCredentialAudience') {
        return { text: sources.principalName ?? t(sources.principalResolving ? 'common.loading' : 'common.unavailable'),
            named: Boolean(sources.principalName), ...(sources.principalResolving ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'privateLabel') {
        return { text: sources.privateLabelName ?? t(sources.privateLabelResolving ? 'common.loading' : 'common.unavailable'),
            named: sources.privateLabelName != null, ...(sources.privateLabelResolving ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'teamCredentialResource') {
        const name = sources.teamCredentialResourceName;
        return { text: name ?? t('common.unavailable'), named: Boolean(name) };
    }
    if (reference?.kind === 'teamCredentialExternalKey') {
        const name = sources.teamCredentialExternalKeyName;
        return { text: name ?? t('common.unavailable'), named: name != null };
    }
    if (reference?.kind === 'teamDirectorySource') {
        const name = sources.teamDirectorySourceName;
        return { text: name ?? t('common.unavailable'), named: Boolean(name) };
    }
    if (isTeamDomainReference(reference)) {
        return { text: sources.teamDomainName ?? t(sources.teamDomainResolving ? 'common.loading' : 'common.unavailable'),
            named: sources.teamDomainName != null, ...(sources.teamDomainResolving ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'homeSetupStep') {
        return { text: sources.homeSetupStepName ?? t('common.unavailable'), named: sources.homeSetupStepName != null };
    }
    if (reference?.kind === 'signInConnection' || reference?.kind === 'signInProvider') {
        const name = sources.signInIdentityName;
        return { text: name ?? t('common.unavailable'), named: Boolean(name) };
    }
    if (reference?.kind === 'teamInvitation') {
        const name = sources.teamInvitationName;
        return { text: name ?? t('common.unavailable'), named: Boolean(name) };
    }
    if (reference?.kind === 'machinePreset' || reference?.kind === 'machinePool') {
        const name = sources.machineCatalogName;
        return { text: name ?? (sources.machineCatalogResolving ? t('common.loading') : t('common.unavailable')),
            named: Boolean(name), ...(sources.machineCatalogResolving ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'managedMachine') {
        const title = readManagedMachineName(sources);
        // The generic word stands in for a machine that could not be read; it is not a name, so a title never
        // takes it as its subject ("Delete managed machine · Machine").
        return { text: title || t(reference.unavailableWithoutName ? 'common.unavailable' : 'contextBar.machine'), named: Boolean(title), subject: 'managedMachine',
            ...(sources.managedMachineLoading && !title ? { resolving: true } : {}) };
    }
    if (reference?.kind === 'skill' || reference?.kind === 'artifact') {
        if (sources.artifactResolving) return { text: t('common.loading'), named: false, resolving: true };
        return readApprovalArtifactReference(reference, ownHome ? artifact : null);
    }
    if (reference?.kind === 'builtinWidget') {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: reference.id });
        const name = descriptor ? t(descriptor.titleKey) : null;
        return { text: name ?? t('common.unavailable'), named: Boolean(name) };
    }
    if (reference?.kind === 'machine') {
        // A machine whose details were never read has no name yet: the reference's own id stands in, unnamed.
        const name = getSettledMachineDisplayName(machine, sources.machineInventory ?? undefined);
        const title = name ?? (reference.unavailableWithoutName ? t('common.unavailable') : reference.id);
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
        return endpoint?.workspaceRef ? { text: describeApprovalWorkspaceEndpoint(endpoint), named: true }
            : { text: reference.unavailableWithoutName ? t('common.unavailable') : literal, named: false };
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
    if (reference?.kind === 'workflow' || reference?.kind === 'workflowRun') {
        const name = reference.kind === 'workflow' ? sources.workflowTitle : sources.workflowRunName;
        if (!name && (reference.kind === 'workflow' ? sources.workflowTitleResolving : sources.workflowRunResolving)) {
            return { text: t('common.loading'), named: false, resolving: true };
        }
        // Unnamed, the card reads it as unavailable and keeps the id in Technical details, as for a Project.
        return { text: name || reference.id, named: Boolean(name) };
    }
    if (reference?.kind === 'agent') {
        const title = agents?.map(row => row.entry.title).join(', ') ?? '';
        return { text: title || reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'setting') {
        const titleKey = readBuiltInSettingUiIdentifierTitleKey(reference.id);
        const title = titleKey ? t(titleKey) : readVoiceSettingsDeclaration(reference.id, sources.localizePluginText)?.title;
        return { text: title ?? reference.id, named: title !== undefined };
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
        return home === null
            ? { text: reference.unavailableWithoutName ? t('common.unavailable') : literal, named: false }
            : { text: home, named: true };
    }
    if (reference?.kind === 'account') {
        const own = viewer !== null && viewer.accountId === reference.id && areServerProfileIdentifiersEquivalent(viewer.serverId, approvalServerId);
        if (own) return { text: t('accountDisplay.yours'), named: true };
    }
    if (reference?.kind === 'approvalProfile') {
        const label = t('teams.settings.memberDefaults.approvalProfile');
        if (reference.id === null) return { text: approvalProfileDefaultNoneTitle(), named: true, label };
        if (sources.approvalProfileName) return { text: sources.approvalProfileName, named: true, label };
        if (sources.approvalProfileResolving) return { text: t('common.loading'), named: false, resolving: true, label };
        return { text: t('common.unavailable'), named: false, label };
    }
    if (sources.principalName) return { text: sources.principalName, named: true };
    if (sources.principalResolving) return { text: t('common.loading'), named: false, resolving: true };
    if (reference?.kind === 'group' || reference?.kind === 'homeAccount') return { text: t('common.unavailable'), named: false };
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

