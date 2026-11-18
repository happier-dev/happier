import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { describeUnnamedApprovalSession } from './approvalRequesterLabels';
import { describeApprovalActionFields, describeApprovalRequestFields } from './approvalFieldValues';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { t } from '@/text';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { settleApprovalRequestActionArgs } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { applyMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { resetMcpServerCatalogEngineForTests } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentReviewConflictFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { presentApprovalFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { DiscussionReplyDestinationResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

it('shows loading destination names while an optional Account name read remains pending', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://reply-names-pending.test' });
    profiles.push(home.id);
    const accountId = 'reply-names-account';
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    });
    // Network transport is the boundary; keep the real credential scope and Action executor.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: 'discussion.reply', summary: 'Reply',
        actionArgs: { discussionId: 'pending-discussion', replyTarget: { kind: 'message', messageId: 'pending-message' },
            content: { v: 1, parts: [{ t: 'text', text: 'Ready.' }] } },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: home.id, actionId: 'discussion.reply', requestId: 'pending-reply' } });
    let bound = false;
    function BoundApproval() {
        const { binding } = useServerCredentialAccountScopeBinding(home.id);
        bound = binding !== null;
        return <ActionApprovalFieldsCard request={request} serverId={home.id} presentation={describeApprovalActionFields(request)} />;
    }
    try {
        const screen = await renderScreen(<BoundApproval />);
        await vi.waitFor(() => expect(bound).toBe(true));
        expect(screen.getTextContent()).toContain(t('common.loading'));
        expect(screen.getTextContent()).not.toContain(t('common.unavailable'));
        await screen.unmount();
    } finally {
        vi.unstubAllGlobals();
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    }
});

it('renders settled failure facts and recovery in the shared disclosure in both approval anatomies', async () => {
    const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict',
        effectAttempted: false, details: DeploymentReviewConflictFailureDetailsV1Schema.parse({ serverId: 'home', environmentId: 'environment',
            targetLinkId: 'target', requiredFact: 'currentEnvironmentRevision', currentEnvironmentRevision: 9,
            remedy: 'Review the latest environment and try again.' }) });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'failed', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'cli' }, actionId: 'session.title.set', summary: 'Rename session',
        actionArgs: { sessionId: 'session', title: 'Release notes' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'home', actionId: 'session.title.set', requestId: 'rename' },
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 2, ...failure } });
    const outcome = presentApprovalFailureOutcome(request, failure);
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy}
            presentation={{ ...describeApprovalActionFields(request), rows: [] }} failureTechnicalDetails={outcome.technicalDetails} />);
        expect(screen.getTextContent()).not.toContain('currentEnvironmentRevision');
        const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
        await act(async () => { details?.props.onExpandedChange(true); });
        const text = screen.getTextContent();
        for (const value of ['deployment_conflict', 'false', 'currentEnvironmentRevision', '9', 'Review the latest environment and try again.']) {
            expect(text).toContain(value);
        }
        await screen.unmount();
    }
});


it('reads ceiling decision context in both approval anatomies without borrowing an unknown Home', async () => {
    const request = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: 'machines.guard.sessionCeiling.set',
        summary: 'Change this session’s memory ceiling',
        actionArgs: { machineId: 'machine', sessionId: 'session', bytes: 2 ** 30 },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
            caller: { kind: 'host' }, serverId: 'unknown-home',
            actionId: 'machines.guard.sessionCeiling.set', requestId: 'ceiling-review' },
    });
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} request={request}
            serverId={null} presentation={describeApprovalActionFields(request)} />);
        const text = screen.getTextContent();
        // Memory reads in binary units (the shared formatHappierDataBytes, kind 'memory').
        expect(text).toContain('1 GiB');
        expect(text).toContain('Not reported');
        expect(text).toMatch(/stop.*resume/is);
        expect(text).not.toContain(String(2 ** 30));
        await screen.unmount();
    }
});

it('keeps an unreadable reply destination visible in both approval anatomies without exposing routing ids', async () => {
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: 'discussion.reply', summary: 'Reply in a discussion',
        actionArgs: { discussionId: 'opaque-discussion', replyTarget: { kind: 'message', messageId: 'opaque-message' },
            content: { v: 1, parts: [{ t: 'text', text: 'Ready for review.' }] } },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'unknown-home', actionId: 'discussion.reply', requestId: 'reply-review' } });
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} request={request}
            serverId={null} presentation={describeApprovalActionFields(request)} />);
        const text = screen.getTextContent();
        expect(text).toContain('Connection');
        expect(text).toContain('Conversation');
        expect(text).toContain(t('common.unavailable'));
        expect(text).toContain('Ready for review.');
        expect(text).not.toContain('opaque-discussion');
        expect(text).not.toContain('opaque-message');
        await screen.unmount();
    }
});

it('renders another Account’s shared Discussion reply destination in both approval anatomies', async () => {
    // Channels' owner suite exercises cross-Account resolution. This consumer test
    // reads its public result through the real Protocol presenter and both UI anatomies.
    const destination = DiscussionReplyDestinationResultV1Schema.parse({ kind: 'channel',
        connectionName: 'Owner name · Email', conversationName: 'External title' });
    if (destination.kind !== 'channel') throw new Error('Expected a Channel destination');
    const discussionId = 'shared-discussion-routing-id';
    const messageId = 'shared-message-routing-id';
    const actionArgs = getActionSpec('discussion.reply').inputSchema.parse({
        discussionId, replyTarget: { kind: 'message', messageId },
        content: { v: 1, parts: [{ t: 'text', text: 'Ready for the external conversation.' }] },
    });
    const presentation = describeApprovalActionFields({ actionId: 'discussion.reply', actionArgs,
        context: { discussionReplyDestination: { discussionId,
            messageId, connectionName: destination.connectionName,
            conversationName: destination.conversationName } } });
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={presentation} />);
        const text = screen.getTextContent();
        for (const value of ['Connection', 'Owner name · Email', 'Conversation', 'External title', 'Ready for the external conversation.']) {
            expect(text).toContain(value);
        }
        for (const id of [discussionId, messageId]) expect(text).not.toContain(id);
        const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
        expect(details).toBeTruthy();
        await act(async () => { details?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain(discussionId);
        await screen.unmount();
    }
});

it('localizes declared enum options in both approval anatomies through the shared presentation', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'machines.managed.power.set',
        actionArgs: { homeId: 'home', managedId: 'guest', when: 'now', intent: 'stop', expectedRevision: 1 } });
    // Target lookup is covered by the Home reference suite; this slice exercises the real option producer and reader.
    const options: ApprovalActionFieldsPresentation = { ...presentation, rows: [
        ...presentation.rows.filter(row => row.path === 'when' || row.path === 'intent'),
        { kind: 'value', path: 'choice', title: 'Choice', value: 'untranslated source',
            selectedOptions: [{ label: 'untranslated source', labelKey: 'common.yes' },
                { label: 'Authored fallback', labelKey: 'unavailable.translation' }] },
    ] };
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={options} />);
        expect(screen.getTextContent()).toContain(t('actionPresentation.options.now'));
        expect(screen.getTextContent()).toContain(t('actionPresentation.options.stop'));
        expect(screen.getTextContent()).toContain(`${t('common.yes')}, Authored fallback`);
        expect(screen.getTextContent()).not.toContain('untranslated source');
    }
});

it('names a readable document reference and retains its exact id only in Technical details', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://document-approval-title.test' });
    profiles.push(home.id);
    const artifactId = '4135b238-607a-458d-b96c-7877d8076877';
    await act(async () => {
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'owner' } });
        storage.getState().applyArtifacts([{ id: artifactId, title: 'Release notes', isDecrypted: true,
            header: { title: 'Release notes' }, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
    });
    const spec = getActionSpec('artifact.public_link.create');
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={describeApprovalActionFields({ actionId: spec.id, actionArgs: spec.inputSchema.parse({ artifactId }) })} />);
    expect(screen.getTextContent()).toContain('Release notes');
    expect(screen.getTextContent()).not.toContain(artifactId);
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain(artifactId);
});

it('reads a Browser view command by its target, keeping its ids and a failure code in the one Technical details', async () => {
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" failureCode="sandbox_unavailable"
        presentation={describeApprovalActionFields({ actionId: 'browser.view.open', actionArgs: {
            commandId: 'cmd-1', browserSessionId: 'browser-session-1', viewId: 'view-1', kind: 'openView', platform: 'web', focus: true,
            target: { targetId: 'target-1', kind: 'externalUrl', url: 'http://127.0.0.1:4000' } } })} />);
    const text = screen.getTextContent();
    expect(text).toContain('http://127.0.0.1:4000');
    for (const plumbing of ['cmd-1', 'view-1', 'target-1', 'openView']) expect(text).not.toContain(plumbing);
    expect(text.split(t('approvals.technicalDetails'))).toHaveLength(2);
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    for (const exact of ['cmd-1', 'browser-session-1', 'view-1', 'target-1', 'openView', 'sandbox_unavailable']) expect(screen.getTextContent()).toContain(exact);
});

it('shows no Details heading over a review whose only facts are technical', async () => {
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={{ rows: [
        { kind: 'value', path: 'action.pluginId', title: 'Plugin id', value: 'happier.triage', technical: true },
    ], unrepresentable: null }} />);
    const text = screen.getTextContent();
    expect(text).toContain(t('approvals.technicalDetails'));
    expect(text).not.toContain(t('approvals.details'));
});

it('renders the shared failure projection in the existing technical disclosure', async () => {
    const { presentActionFailureTechnicalDetails } = await import('@/components/tools/shell/approvals/approvalFailureOutcome');
    const { DeploymentSourceAdmissionFailureV1Schema } = await import('@happier-dev/protocol/deployments/deploymentReceiptEventsV1');
    const failureTechnicalDetails = presentActionFailureTechnicalDetails({ errorCode: 'agent_isolation_unavailable',
        error: 'agent_isolation_unavailable', effectAttempted: false,
        details: DeploymentSourceAdmissionFailureV1Schema.parse({ phase: 'deployment_source_admission',
            reason: 'requester_authority_unavailable', requiredFact: 'verified_root_requester', remedy: 'retry_original_request' }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" failureTechnicalDetails={failureTechnicalDetails}
        presentation={describeApprovalActionFields({ actionId: 'session.title.set', actionArgs: { sessionId: 'session-1', title: 'Release notes' } })} />);
    expect(screen.getTextContent()).not.toContain('verified_root_requester');
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    for (const value of ['agent_isolation_unavailable', 'requester_authority_unavailable', 'verified_root_requester', 'retry_original_request']) {
        expect(screen.getTextContent()).toContain(value);
    }
});

it('keeps the exact identity of a Home this device cannot name in Technical details, never in the readable rows', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'session.title.set', actionArgs: { sessionId: 'session-1', title: 'Release notes' } });
    const identity = 'srv_elsewhere_9f3 · stack_qa_main__id_default';
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} homeIdentity={identity} />);
    expect(screen.getTextContent()).not.toContain(identity);
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain(identity);
});

it.each([
    [{ clientId: 'public-oauth-app', clientSecret: 'private-oauth-secret' }, 'set'],
    [null, 'remove'],
] as const)('renders the reviewed OAuth app change in pending and settled approval anatomies: %j', async (client, operation) => {
    const spec = getActionSpec('mcp.servers.signIn.start');
    const raw = spec.inputSchema.parse({ serverId: 'mcp-oauth', client });
    const open = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: spec.id, summary: spec.title,
        actionArgs: spec.projectObservationInput!(raw),
        preview: { actionId: spec.id, actionArgs: spec.approvalPresentation!.projectInput!(raw) },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'home', actionId: spec.id, requestId: 'oauth-review' },
    });
    for (const status of ['open', 'rejected'] as const) {
        const request = status === 'open' ? open : { ...open, status, actionArgs: settleApprovalRequestActionArgs(open) };
        for (const anatomy of ['page', 'card'] as const) {
            const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy}
                presentation={describeApprovalRequestFields(request)} />);
            const text = screen.getTextContent();
            expect(text).toContain(t(operation === 'set' ? 'capabilities.mcpSignIn.reviewSetApp' : 'capabilities.mcpSignIn.reviewRemoveApp'));
            if (client) expect(text).toContain(client.clientId);
            expect(text).not.toContain('private-oauth-secret');
            expect(text).not.toContain('Client secret');
            await screen.unmount();
        }
    }
});

it.each(['open', 'executed'] as const)('names the MCP catalog title in %s approvals and keeps the id in Technical details', async (status) => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://mcp-approval-title.test' });
    profiles.push(home.id);
    const accountId = 'mcp-approval-account';
    const serverId = 'fd1b6b4c-a056-48c8-b2dd-1787091b9dd7';
    const scope = { serverId: home.id, accountId };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    });
    // Use the real destination-row shape and scoped catalog hook, not a mocked reference reader.
    const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{
        id: serverId, name: 'filesystem', title: 'Filesystem', transport: 'stdio',
        stdio: { command: 'filesystem-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [] });
    await act(async () => {
        storage.setState({ settingsScope: scope });
        applyMcpServerCatalogSnapshot(scope, { status: 'ready', catalog, revision: 1, authority: 'active', diagnostics: [] }, true);
    });
    const spec = getActionSpec('mcp.rules.set');
    const open = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Turn on Filesystem', actionId: spec.id,
        actionArgs: spec.inputSchema.parse({ items: [{ serverId }], change: {
            kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' },
        } }), executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: home.id, actionId: spec.id, requestId: 'mcp-title-approval' },
    });
    const request = status === 'open' ? open : ApprovalRequestV2Schema.parse({ ...open, status, updatedAtMs: 3,
        actionArgs: settleApprovalRequestActionArgs(open), decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true },
    });
    try {
        for (const anatomy of ['page', 'card'] as const) {
            const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} serverId={home.id}
                presentation={describeApprovalRequestFields(request)} />);
            const text = screen.getTextContent();
            for (const value of ['MCP server', 'Filesystem', 'Everywhere', 'Turn on']) expect(text).toContain(value);
            expect(text).not.toContain('filesystem');
            expect(text).not.toContain(serverId);
            const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
            expect(details).toBeTruthy();
            await act(async () => { details?.props.onExpandedChange(true); });
            expect(screen.getTextContent()).toContain(serverId);
        }
    } finally {
        await act(async () => { await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id }); });
    }
});

it('names reviewed skills and the exact Home machine, keeping their ids in Technical details', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://capability-approval.test' });
    profiles.push(home.id);
    const skillId = 'opaque-reviewed-skill';
    const machineId = 'opaque-reviewed-machine';
    const machine = createMachineFixture({ id: machineId, metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } });
    await act(async () => {
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'account' },
            machineListByServerId: { [home.id]: [machine] } });
        storage.getState().applyArtifacts([{ id: skillId, title: 'Release notes', isDecrypted: true,
            header: { v: 1, kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'Release notes' },
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
    });
    const spec = getActionSpec('skills.rules.set');
    const actionArgs = spec.inputSchema.parse({ items: [{ skillId }], change: {
        kind: 'write', write: { place: { t: 'machine', machineId }, state: 'on' },
    } });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={describeApprovalActionFields({ actionId: spec.id, actionArgs,
            preview: { actionId: spec.id, actionArgs: spec.projectObservationInput?.(actionArgs) } })} />);
    const text = screen.getTextContent();
    for (const value of ['Skill', 'Release notes', 'Where', 'Studio', 'Change', 'Turn on']) expect(text).toContain(value);
    for (const value of [skillId, machineId, 'Rules change', 'Kind Write', 'State on']) expect(text).not.toContain(value);
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain(skillId);
    expect(screen.getTextContent()).toContain(machineId);
});

it('reads a workspace-sync request by its machine and the two folders it links, keeping the ids in Technical details', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://workspace-sync-approval.test' });
    profiles.push(home.id);
    const scope = { serverId: home.id, accountId: 'sync-account' };
    const policyFields = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const machines = [['machine-studio', 'Studio'], ['machine-laptop', 'Laptop']] as const;
    await act(async () => {
        storage.setState({ settingsScope: scope, profileScope: scope,
            machineListByServerId: { [home.id]: machines.map(([id, displayName]) => createMachineFixture({
                id, metadata: { ...createMachineFixture().metadata!, displayName } })) },
            machineDisplayById: Object.fromEntries(machines.map(([id, displayName]) => [id, { id, metadata: { displayName } }])) as never,
            projectAccountRows: { scope, status: 'ready', coverage: 'complete', organizations: [], revisionsByPhysicalKey: {},
                workspaceRefs: [
                    { id: 'ref-studio', serverId: home.id, machineId: 'machine-studio', rootPath: '/home/me/payments', label: null, createdAtMs: 1 },
                    { id: 'ref-laptop', serverId: home.id, machineId: 'machine-laptop', rootPath: '/Users/me/payments-copy', label: null, createdAtMs: 1 },
                ],
                relationships: [{ v: 1, relationshipId: 'relationship_9f2c', controllerMachineId: 'machine-studio',
                    alphaWorkspaceRefId: 'ref-studio', betaWorkspaceRefId: 'ref-laptop', mode: 'keep_synced',
                    contentPolicy: { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) },
                    enabled: true, createdAtMs: 1, updatedAtMs: 1 }] } });
    });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={describeApprovalActionFields({ actionId: 'workspace.sync.relationship.flush',
            actionArgs: { controllerMachineId: 'machine-studio', relationshipId: 'relationship_9f2c' } })} />);
    const text = screen.getTextContent();
    for (const value of ['Controller machine', 'Studio', 'Linked folders', 'payments · Studio', 'payments-copy · Laptop']) expect(text).toContain(value);
    for (const id of ['machine-studio', 'relationship_9f2c', '/home/me']) expect(text).not.toContain(id);
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain('machine-studio');
    expect(screen.getTextContent()).toContain('relationship_9f2c');
});

it('says a workspace-sync link no longer exists instead of showing its id, keeping the id in Technical details', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://workspace-sync-gone.test' });
    profiles.push(home.id);
    const scope = { serverId: home.id, accountId: 'sync-account' };
    await act(async () => {
        storage.setState({ settingsScope: scope, profileScope: scope,
            projectAccountRows: { scope, status: 'ready', coverage: 'complete', organizations: [], revisionsByPhysicalKey: {},
                workspaceRefs: [], relationships: [] } });
    });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={describeApprovalActionFields({ actionId: 'workspace.sync.relationship.flush',
            actionArgs: { controllerMachineId: 'machine-studio', relationshipId: 'relationship_gone42' } })} />);
    const text = screen.getTextContent();
    expect(text).toContain(t('approvals.linkRemoved'));
    expect(text).not.toContain('relationship_gone42');
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain('relationship_gone42');
});

it('shows a declared confidential input as supplied under its declared title, beside the exact public JSON, in both anatomies', async () => {
    const presentation: ApprovalActionFieldsPresentation = { rows: [
        { kind: 'value', path: 'input.token', title: 'Release token', value: '', valueFormat: 'confidential' },
        { kind: 'value', path: 'input.releaseTag', title: 'Release tag', value: '"v1.2.0"' },
    ], unrepresentable: null };
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={presentation} />);
        const text = screen.getTextContent();
        expect(text).toContain('Release token');
        expect(text).toContain(t('approvals.confidentialSupplied'));
        expect(text).toContain('"v1.2.0"');
        expect(text).not.toContain(t('common.unavailable'));
    }
});

const initialState = storage.getState();
const profiles: string[] = [];

afterEach(async () => {
    await standardCleanup();
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    storage.setState(initialState);
    for (const id of profiles.splice(0)) await removeServerProfile(id);
});

it('presents a plugin install approval as the simple install consent, keeping raw values in Technical details', async () => {
    const locator = '/plugins/acme.example';
    const actionArgs = { path: locator, kind: 'path' as const, dev: true };
    const network = {
        id: 'network', capability: 'network', reason: 'Call the service.',
        authorizationClass: 'cooperativeDisclosure' as const,
        normalizedScope: { methods: ['POST'], targets: [{ kind: 'fixedOrigin', origin: 'http://127.0.0.1:5199' }] },
    };
    const rawCredential = {
        accessMode: 'raw' as const,
        contribution: { pluginId: 'acme.example', localId: 'speech' },
        credentialSlot: { id: 'api_key', title: 'API key', purpose: 'voice.speech' },
        sourceClass: { kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] },
        realm: 'daemon' as const, phase: 'speech' as const,
        request: { kind: 'environment' as const, keys: ['VOICE_TOKEN'] },
    };
    const requestFor = (pendingReview: Readonly<Record<string, unknown>>) => ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: 'plugins.install', actionArgs, summary: 'Install plugin',
        executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' },
            requestId: 'plugin-install-request', surface: 'cli', serverId: 'home', actionId: 'plugins.install' },
        preview: { actionId: 'plugins.install', actionArgs, pluginInstall: {
            permissionsDisclosure: 'daemonEvaluated',
            pendingReview: { kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending-plugin-install', ...pendingReview },
        } },
    });
    const firstInstall = describeApprovalRequestFields(requestFor({
        reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
        review: createPluginInstallationReviewFixture({
            source: { kind: 'path', locator }, updateChannel: { kind: 'path', locator, development: true },
            requiredHostAccess: [network],
        }),
    }));
    const newScope = describeApprovalRequestFields(requestFor({
        reason: 'authorityExpansion', currentVersion: '0.9.0', authorityExpansion: ['rawCredentialAccess'],
        review: createPluginInstallationReviewFixture({ requiredHostAccess: [network], rawCredentialAccess: [rawCredential] }),
    }));

    for (const anatomy of ['card', 'page'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={firstInstall} anatomy={anatomy} />);
        const text = screen.getTextContent();
        // First install: the plugin and everything it uses, in one short reading.
        for (const value of ['Example', t('settingsPlugins.installReviewSections.requiredAccess'), 'Network']) {
            expect(text).toContain(value);
        }
        // The detailed evidence review is gone; raw values wait behind Technical details.
        for (const gone of [t('settingsPlugins.installReviewSections.trustedCodeTitle'),
            t('settingsPlugins.installReviewSections.evidence'), 'cooperativeDisclosure']) {
            expect(text).not.toContain(gone);
        }
        const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
        await act(async () => { details?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain('cooperativeDisclosure');

        // An update that asks for more lists only what is new, against the installed version.
        const update = (await renderScreen(<ActionApprovalFieldsCard presentation={newScope} anatomy={anatomy} />)).getTextContent();
        for (const value of ['0.9.0 → 1.0.0', t('settingsPlugins.installReviewSections.rawCredentials'), 'API key']) {
            expect(update).toContain(value);
        }
        expect(update).not.toContain(t('settingsPlugins.installReviewSections.requiredAccess'));
    }
});

it('keeps an installed plugin update\'s source selector behind Technical details, like an install\'s', async () => {
    // The Plugins page's Update asks `plugins.install` for the installed plugin by its source selector.
    const actionArgs = { source: { kind: 'installed' as const, pluginId: 'acme.example' } };
    const request = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId: 'plugins.install', actionArgs, summary: 'Install plugin',
        executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' },
            requestId: 'plugin-update-request', surface: 'cli', serverId: 'home', actionId: 'plugins.install' },
        preview: { actionId: 'plugins.install', actionArgs, pluginInstall: {
            permissionsDisclosure: 'daemonEvaluated',
            pendingReview: { kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending-plugin-update',
                reason: 'authorityExpansion', currentVersion: '0.9.0', authorityExpansion: ['requiredHostAccess'],
                review: createPluginInstallationReviewFixture({}) },
        } },
    });
    const screen = await renderScreen(<ActionApprovalFieldsCard presentation={describeApprovalRequestFields(request)} anatomy="page" />);
    const text = screen.getTextContent();
    expect(text).toContain('0.9.0 → 1.0.0');
    // The consent names the plugin; its selector is routing, not something the person decides on.
    expect(text).not.toContain('acme.example');
    const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { details?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain('acme.example');
});

it('identifies a Delete approval by Session title, Machine, and id tail', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://delete-approval.test' });
    profiles.push(home.id);
    const sessionId = 'cmv9jgd3q016xmcvegf6icb89';
    const machineId = 'machine-delete-target';
    const machine = createMachineFixture({ id: machineId, metadata: {
        ...createMachineFixture().metadata!, displayName: 'QA workstation',
    } });
    await act(async () => {
        storage.setState({
            settingsScope: { serverId: home.id, accountId: 'account' },
            machines: { ...storage.getState().machines, [machineId]: machine },
            machineListByServerId: { ...storage.getState().machineListByServerId, [home.id]: [machine] },
        });
        storage.getState().applySessions([createSessionFixture({
            id: sessionId,
            serverId: home.id,
            metadata: { ...createSessionFixture().metadata!, name: 'Release cleanup', machineId },
        })]);
    });
    const presentation = describeApprovalActionFields({ actionId: 'session.delete', actionArgs: { sessionId } });

    for (const anatomy of ['card', 'page'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} serverId={home.id} />);
        const text = screen.getTextContent();
        expect(text).toContain('Release cleanup');
        expect(text).toContain('QA workstation');
        expect(text).toContain(sessionId.slice(-8));
    }
});

it('tells a Machine apart from same-named Machines on its Home by the suffix its picker uses', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://same-name-machines.test' });
    profiles.push(home.id);
    const named = (id: string) => createMachineFixture({ id, metadata: {
        ...createMachineFixture().metadata!, displayName: 'NLDW3-5-36-33', host: 'nldw3' } });
    const target = named('eadc2422-7f3c');
    const peer = named('eadf0913-2b1a');
    await act(async () => {
        storage.setState({
            settingsScope: { serverId: home.id, accountId: 'account' },
            machines: { ...storage.getState().machines, [target.id]: target, [peer.id]: peer },
            machineListByServerId: { ...storage.getState().machineListByServerId, [home.id]: [target, peer] },
        });
    });
    const presentation = describeApprovalActionFields({ actionId: 'plugins.install', actionArgs: {
        machineId: target.id, source: { kind: 'installed', pluginId: 'acme.storage' } } });
    const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={home.id} />);
    expect(screen.getTextContent()).toContain('NLDW3-5-36-33 · eadc');
});

it('keeps widget placement internals behind the canonical Details disclosure', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'widgets.group.add', actionArgs: {
        surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } },
        group: { kind: 'group', id: 'opaque-group', title: 'Release checks', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
            { kind: 'widget', instance: { v: 1, id: 'opaque-child', displayName: 'Pull requests', bindings: {},
                definition: { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'latest' } } } },
        ] },
    } });
    for (const anatomy of ['card', 'page'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        expect(screen.getTextContent()).toContain('Release checks');
        expect(screen.getTextContent()).toContain('Pull requests');
        for (const value of ['opaque-group', 'opaque-child', 'happier.triage', 'latest']) expect(screen.getTextContent()).not.toContain(value);
        const details = screen.findAllByTestId('approvals.technical-details').find(node => typeof node.props.onExpandedChange === 'function');
        await act(async () => { details?.props.onExpandedChange(true); });
        for (const value of ['opaque-group', 'opaque-child', 'happier.triage', 'latest']) expect(screen.getTextContent()).toContain(value);
    }
});

it('reads the declared setting name and exact new value in both approval anatomies', async () => {
    const anchor = 'delegation.workDepthLimit';
    const presentation = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor, value: 3 } });
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        const text = screen.getTextContent();
        expect(text).toContain(t(builtInSettingUiDeclaration(anchor).titleKey));
        expect(text).toContain('3');
        expect(text).not.toContain(anchor);
        const details = screen.findAllByTestId('approvals.technical-details')
            .find(node => typeof node.props.onExpandedChange === 'function');
        await act(async () => { details?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain(anchor);
    }
});

it('the approval Details page preserves an exact remote host id when a session has the same id', async () => {
    const profile = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://approval-reference.test' });
    profiles.push(profile.id);
    const otherHome = await upsertServerProfile({ name: 'Unrelated Home', serverUrl: 'https://unrelated-approval-reference.test' });
    profiles.push(otherHome.id);
    const hostId = 'exact-remote-host';
    const session = createSessionFixture();
    if (!session.metadata) throw new Error('Missing Session metadata fixture');
    const metadata = session.metadata;
    await act(async () => {
        storage.getState().applySessions([
            createSessionFixture({ id: hostId, serverId: profile.id,
                metadata: { ...metadata, name: 'Unrelated same-id session' } }),
            createSessionFixture({ id: profile.id, serverId: profile.id,
                metadata: { ...metadata, name: 'Session sharing Home token' } }),
        ]);
    });
    // The Home's Session list has been read: a Session it does not hold is absent, not still loading.
    storage.setState({ concurrentSessionListCacheByServerId: { [profile.id]: { serverName: null,
        listObservation: { phase: 'ready', lastSuccessAt: 1 } } } });
    const presentation = { rows: [
        { kind: 'value', path: 'hostId', title: 'Remote host', value: hostId },
        { kind: 'value', path: 'operation.kind', title: 'Operation', value: 'disable' },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const details = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={profile.id} />);
    expect(details.getTextContent()).toContain(hostId);
    expect(details.getTextContent()).not.toContain('Unrelated same-id session');

    // Save/duplicate and relay Address admit any nonempty literal host identity,
    // including text that happens to resemble a structured Session reference.
    const structuredLookingHostId = JSON.stringify({ kind: 'host', id: hostId });
    const structuredLookingHost = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [{ kind: 'value', path: 'hostId', title: 'Remote host', value: structuredLookingHostId }],
        unrepresentable: null,
    }} />);
    expect(structuredLookingHost.getTextContent()).toContain(structuredLookingHostId);
    expect(structuredLookingHost.getTextContent()).not.toContain('Unrelated same-id session');

    // The renderer consumes Protocol's typed reference projection, not path/value guesses.
    // describeApprovalReference emits these shapes for declared Session and serverId fields.
    const references = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [
            { kind: 'value', path: 'sessionId', title: 'Session', value: hostId,
                reference: { kind: 'session', id: hostId } },
            { kind: 'value', path: 'serverId', title: 'Home', value: profile.id,
                reference: { kind: 'home', id: profile.id } },
            { kind: 'value', path: 'parentSessionId', title: 'Unavailable session', value: otherHome.id,
                reference: { kind: 'session', id: otherHome.id } },
        ], unrepresentable: null,
    }} />);
    expect(references.getTextContent()).toContain('Unrelated same-id session');
    expect(references.getTextContent()).toContain('Approval Home');
    expect(references.getTextContent()).not.toContain('Session sharing Home token');
    expect(references.getTextContent()).not.toContain('Unrelated Home');
    expect(references.getTextContent()).toContain(describeUnnamedApprovalSession('Approval Home'));
});

it('reads a structured value as labelled entries rather than raw JSON, in both anatomies', async () => {
    const literal = JSON.stringify({ kind: 'create', board: { title: 'Launch plan' } });
    const presentation = { rows: [{
        kind: 'value', path: 'intent', title: 'Board intent', value: literal,
        entries: [
            { label: 'Kind', value: 'create', depth: 0 },
            { label: 'Board', value: null, depth: 0 },
            { label: 'Title', value: 'Launch plan', depth: 1 },
        ],
    }], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        const text = screen.getTextContent();
        expect(text).toContain('Board intent');
        expect(text).toContain('Launch plan');
        expect(text).toContain('Kind');
        expect(text).not.toContain(literal);
    }
});

it('gives a structured value the same row as its sibling arguments on the approval page', async () => {
    const { Item } = await import('@/components/ui/lists/Item');
    const presentation = { rows: [
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' },
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{"area":"main"}',
            entries: [{ label: 'Area', value: 'main', depth: 0 }] },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" />);
    // Every argument reads name-over-value through the one row owner, so a structured value cannot
    // invert the hierarchy its siblings use (a small label over large values).
    // A wide page sets each label in the one label column beside its value; a phone stacks it as the title.
    const labels = screen.findAllByType(Item).map((item) => typeof item.props.title === 'string' ? item.props.title : item.props.title.props.label);
    expect(labels).toEqual(['Group id', 'Widget surface']);
    expect(screen.getTextContent()).toContain('Area');
});

it('reads references by name, keeps exact ids in Technical details, and drops meaningless internals', async () => {
    const profile = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://approval-technical.test' });
    profiles.push(profile.id);
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    await act(async () => { storage.setState({ settingsScope: { serverId: profile.id, accountId } }); });
    const presentation = { rows: [
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{}', entries: [
            { label: 'Server id', value: profile.id, depth: 0, reference: { kind: 'home', id: profile.id } },
            { label: 'Account id', value: accountId, depth: 0, reference: { kind: 'account', id: accountId } },
            { label: 'Owner', value: null, depth: 0 },
            { label: 'Page id', value: 'usage', depth: 1 },
            { label: 'V', value: '7', depth: 1, technical: true },
            { label: 'Bindings', value: '{}', depth: 1, technical: true },
        ] },
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} serverId={profile.id} />);
        const text = screen.getTextContent();
        expect(text).toContain('Approval Home');
        expect(text).toContain('Your account');
        // A target id stays in view: the approval shows exactly what it acts on.
        expect(text).toContain('usage-group');
        expect(text).toContain('usage');
        expect(text).not.toContain(profile.id);
        expect(text).not.toContain(accountId);
        // A key over a name names the thing, not its id: "Home · Approval Home", "Account · Your account".
        expect(text).not.toContain('Server id');
        expect(text).not.toContain('Account id');
        expect(text).toContain('Account');
        const technical = screen.findAllByTestId('approvals.technical-details')
            .find((node) => typeof node.props.onExpandedChange === 'function');
        expect(technical).toBeTruthy();
        await act(async () => { technical?.props.onExpandedChange(true); });
        const opened = screen.getTextContent();
        expect(opened).toContain(accountId);
        expect(opened).toContain(profile.id);
        expect(opened).not.toContain('Widget surface › Owner › V');
        expect(opened).not.toContain('Widget surface › Owner › Bindings');
        expect(opened).not.toContain('{}');
        // The exact id behind a name keeps its id label in Technical details.
        expect(opened).toContain('Widget surface › Server id');
    }
});

it('reads the approval\u2019s own Home and Account when the request carries the Home\u2019s portable identity', async () => {
    // An unnamed Home: the request's `serverId` is the Home's identity, this device addresses it by a profile id.
    const url = 'https://approval-identity.test';
    const created = await upsertServerProfile({ serverUrl: url });
    profiles.push(created.id);
    await setServerProfileIdentityForUrl(url, 'srv_portable_identity');
    const accountId = 'viewer-account';
    await act(async () => { storage.setState({ settingsScope: { serverId: 'srv_portable_identity', accountId } }); });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={created.id} presentation={{ rows: [
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{}', entries: [
            { label: 'Server id', value: 'srv_portable_identity', depth: 0, reference: { kind: 'home', id: 'srv_portable_identity' } },
            { label: 'Account id', value: accountId, depth: 0, reference: { kind: 'account', id: accountId } },
        ] },
    ], unrepresentable: null }} />);
    const text = screen.getTextContent();
    expect(text).not.toContain('srv_portable_identity');
    expect(text).not.toContain(accountId);
    expect(text).toContain('Your account');
});

it('keeps a collapsed card to its Details line until the person opens it', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'browser.view.open', actionArgs: {
        commandId: 'cmd-1', browserSessionId: 'browser-session-1', viewId: 'view-1', kind: 'openView', platform: 'web', focus: true,
        target: { targetId: 'target-1', kind: 'externalUrl', url: 'http://127.0.0.1:4000' } } });
    const screen = await renderScreen(<ActionApprovalFieldsCard collapsed presentation={presentation} />);
    expect(screen.getTextContent()).toContain(t('approvals.details'));
    expect(screen.getTextContent()).not.toContain('http://127.0.0.1:4000');
    const disclosure = screen.findAllByTestId('approvals.details-disclosure').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { disclosure?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain('http://127.0.0.1:4000');
});

it('reads an open card\'s arguments as one key/value table with no inner card heading, the technical line as its last row', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'browser.view.open', actionArgs: {
        commandId: 'cmd-1', browserSessionId: 'browser-session-1', viewId: 'view-1', kind: 'openView', platform: 'web', focus: true,
        target: { targetId: 'target-1', kind: 'externalUrl', url: 'http://127.0.0.1:4000' } } });
    const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} />);
    // One table holds every argument, label beside value; the card repeats no "Details" heading of its own.
    const table = screen.findByTestId('approvals.fields-table');
    expect(table).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(t('approvals.details'));
    expect(screen.getTextContent()).toContain('http://127.0.0.1:4000');
    const first = presentation.rows.find(row => row.kind === 'value' && !row.technical);
    expect(screen.findByTestId(`approvals.fields-table.row:${first?.path}`)).not.toBeNull();
});
