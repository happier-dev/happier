import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { expandDisclosureAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
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
import { presentActionApproval, readApprovalPreviewSummary } from './actionApprovalPresentation';

it.each([
    { actionId: 'machines.managed.delete', actionArgs: { homeId: 'home-a', managedId: 'managed-a', expectedRevision: 2,
        intent: 'delete', when: 'now', reviewedDependencies: true } },
    { actionId: 'machines.reboot', actionArgs: { serverId: 'home-a', machineId: 'machine-a', expectedInstallationId: 'install-a' } },
] as const)('keeps the $actionId reference refusal in Technical details', async ({ actionId, actionArgs }) => {
    const partial = { homeId: 'home-a', coverage: 'partial', references: [], failureCause: {
        phase: 'project.requester_admission', errorClass: 'Error', errorCode: 'project_requester_authority_unavailable',
        httpStatus: null, nativeErrorReason: 'signed_root_projection',
    } };
    const preview = actionId === 'machines.managed.delete'
        ? { machineReferences: { ...partial, machineId: null, unavailable: ['requester_authority'] } }
        : { machineRebootReview: { kind: 'machineReboot', deploymentReferences: { ...partial, machineId: 'machine-a', nextCursor: null } } };
    const request = { actionId, actionArgs, preview };
    const screen = await renderScreen(<ActionApprovalFieldsCard request={request} presentation={describeApprovalActionFields(request)} anatomy="page" />);
    expect(screen.getTextContent()).not.toContain('signed_root_projection');
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain('project_requester_authority_unavailable');
    expect(screen.getTextContent()).toContain('signed_root_projection');
});

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
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    for (const value of ['agent_isolation_unavailable', 'requester_authority_unavailable', 'verified_root_requester', 'retry_original_request']) {
        expect(screen.getTextContent()).toContain(value);
    }
});

it('keeps the exact identity of a Home this device cannot name in Technical details, never in the readable rows', async () => {
    const presentation = describeApprovalActionFields({ actionId: 'session.title.set', actionArgs: { sessionId: 'session-1', title: 'Release notes' } });
    const identity = 'srv_elsewhere_9f3 · stack_qa_main__id_default';
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} homeIdentity={identity} />);
    expect(screen.getTextContent()).not.toContain(identity);
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
            await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain(skillId);
    expect(screen.getTextContent()).toContain(machineId);
});

it('names a Machine this device cannot read as an em dash with its reason, never an id label beside "Unavailable"', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://other-machine-approval.test' });
    profiles.push(home.id);
    const machineId = 'machine-of-another-kit';
    await act(async () => {
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'account' }, machineListByServerId: { [home.id]: [] } });
    });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={describeApprovalActionFields({ actionId: 'machines.services.list', actionArgs: { serverId: home.id, machineId } })} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const text = screen.getTextContent();
    expect(text).toContain('Machine');
    expect(text).not.toContain('Machine ID');
    expect(text).not.toContain(t('common.unavailable'));
    expect(text).toContain('—');
    expect(text).toContain(t('approvals.referenceNameUnavailable'));
    expect(text).not.toContain(machineId);
    // The exact id keeps its own key, one press away.
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain('Machine ID');
    expect(screen.getTextContent()).toContain(machineId);
    await screen.unmount();
});

it('titles a keyed field in Technical details in words, never its translation key', async () => {
    const request = { actionId: 'artifact.public_link.create', actionArgs: { artifactId: 'artifact-own-doc' } };
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={null}
        presentation={describeApprovalActionFields(request)} />);
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    const text = screen.getTextContent();
    expect(text).toContain('artifact-own-doc');
    expect(text).toContain(t('approvals.publicLinkFields.document'));
    expect(text).not.toContain('approvals.publicLinkFields.');
    await screen.unmount();
});

it('keeps a cold own Document resolving until the exact network read settles', async () => {
    const { createArtifactInventoryDemandHarness } = await import('@/dev/testkit/harness/artifactInventoryDemandHarness');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let reading = false;
    let hold = false;
    const harness = await createArtifactInventoryDemandHarness({ handleRequest: async (url) => {
        if (!hold || url.pathname !== '/v1/artifacts/read') return null;
        reading = true;
        await pending;
        return null;
    } });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    const serverId = getActiveServerSnapshot().serverId;
    const doc = harness.inventory[0]!;
    hold = true;
    storage.getState().deleteArtifact(doc.id);
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={serverId}
        presentation={describeApprovalActionFields({ actionId: 'artifact.public_link.create', actionArgs: { artifactId: doc.id } })} />);
    try {
        await vi.waitFor(() => expect(reading).toBe(true));
        expect(screen.getTextContent()).toContain(t('common.loading'));
        expect(screen.getTextContent()).not.toContain(t('approvals.referenceNameUnavailable'));
        await act(async () => { release(); });
        await vi.waitFor(() => expect(storage.getState().artifacts[doc.id]?.isDecrypted).toBe(true));
        expect(screen.getTextContent()).toContain('Inventory fixture');
        expect(screen.getTextContent()).not.toContain(t('approvals.referenceNameUnavailable'));
    } finally { release(); await screen.unmount(); await harness.dispose(); }
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
        for (const value of ['opaque-group', 'opaque-child', 'happier.triage', 'latest']) expect(screen.getTextContent()).toContain(value);
    }
});

it.each([
    { anchor: 'delegation.workDepthLimit', value: 3, displayed: '3' },
    { anchor: 'voiceConversations.silenceMs', value: 1400, displayed: '1.4 s' },
    { anchor: 'voiceConversations.minSpeechMs', value: 300, displayed: '0.3 s' },
    { anchor: 'appearance.textSize', value: 1.1, displayed: '110 %' },
    { anchor: 'voiceConversations.provider.happier.voice.xai/realtime-grok.turnDetection.silenceDurationMs', value: 1400, displayed: '1.4 s' },
])('reads the declared $anchor name and displayed units without changing the approved value', async ({ anchor, value, displayed }) => {
    const actionArgs = Object.freeze({ anchor, value });
    const request = { actionId: 'settings.set', actionArgs };
    expect(presentActionApproval(request).summary).toContain(displayed);
    expect(readApprovalPreviewSummary({ summary: 'Change this setting.' }, request)).toContain(displayed);
    const presentations = [describeApprovalActionFields(request)];
    if (anchor.startsWith('voiceConversations.provider.')) presentations.push(describeApprovalRequestFields(ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' },
        ...request, summary: 'Change the silence duration',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'home', actionId: 'settings.set', requestId: 'provider-silence' },
    })));
    for (const presentation of presentations) for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        const text = screen.getTextContent();
        expect(text).toContain(t(anchor.startsWith('voiceConversations.provider.')
            ? 'settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.title'
            : builtInSettingUiDeclaration(anchor).titleKey));
        expect(text).toContain(displayed);
        expect(text).not.toContain(anchor);
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
        expect(screen.getTextContent()).toContain(anchor);
        await screen.unmount();
    }
    expect(request.actionArgs).toEqual({ anchor, value });
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
        await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
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

it('shows a folded card\'s first fact, keeping only the remaining facts behind Details until the person opens it', async () => {
    // UI refinements ruling 2026-11-24 10:38Z: a person sees what they approve before Approve is in reach, at every
    // width: the first fact (the deciding value) stands above the fold; Details folds the rest.
    const presentation = describeApprovalActionFields({ actionId: 'browser.view.open', actionArgs: {
        commandId: 'cmd-1', browserSessionId: 'browser-session-1', viewId: 'view-1', kind: 'openView', platform: 'web', focus: true,
        target: { targetId: 'target-1', kind: 'externalUrl', url: 'http://127.0.0.1:4000' } } });
    const first = presentation.rows.find(row => row.kind === 'value' && !row.technical);
    expect(first?.kind === 'value' ? first.title : null).toBeTruthy();
    const screen = await renderScreen(<ActionApprovalFieldsCard collapsed presentation={presentation} />);
    expect(screen.getTextContent()).toContain(t('approvals.details'));
    expect(screen.getTextContent()).toContain(first?.kind === 'value' ? first.title : '');
    expect(screen.getTextContent()).not.toContain('http://127.0.0.1:4000');
    const disclosure = screen.findAllByTestId('approvals.details-disclosure').find(node => typeof node.props.onExpandedChange === 'function');
    await act(async () => { disclosure?.props.onExpandedChange(true); });
    expect(screen.getTextContent()).toContain('http://127.0.0.1:4000');
});

it('leaves out of a folded card a fact whose value its sentence already names, keeping the rest', async () => {
    // UI refinements ruling 2026-11-25 01:47Z: facts never restate a value the summary sentence already names.
    const presentation = { rows: [
        { kind: 'value', path: 'title', title: 'Title', value: 'W28 label group' },
        { kind: 'value', path: 'visibility', title: 'Visibility', value: 'Team only' },
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'group-7f3a', technical: true },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const screen = await renderScreen(<ActionApprovalFieldsCard collapsed presentation={presentation}
        summary="Rename the label group to “W28 label group”." />);
    const text = screen.getTextContent();
    expect(text).not.toContain('W28 label group');
    expect(text).toContain('Visibility');
    expect(text).toContain('Team only');
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain('group-7f3a');
});

it('folds only codes behind Technical details itself when a folded card has no facts after its first', async () => {
    // "Details" names facts; with nothing but ids behind it, the card shows the one Technical details disclosure, one press deep.
    const presentation = { rows: [
        { kind: 'value', path: 'title', title: 'Title', value: 'W28 label group' },
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'group-7f3a', technical: true },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const screen = await renderScreen(<ActionApprovalFieldsCard collapsed presentation={presentation} />);
    expect(screen.getTextContent()).toContain('W28 label group');
    expect(screen.getTextContent()).not.toContain(t('approvals.details'));
    expect(screen.findAllByTestId('approvals.details-disclosure')).toHaveLength(0);
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain('group-7f3a');
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

it('keeps a declared contributed Action\'s raw input in Technical details without its schema version', async () => {
    const fields = { scopeId: 'github:1424792902', title: 'Focus returns to the top after Deny', body: 'Seen on phones.' };
    // The stored target request: declared facts read from its operands, its raw input kept for Technical details.
    const presentation = describeApprovalRequestFields({ kind: 'plugin_target_action', status: 'open', secretInputPaths: [],
        input: { v: 1, instance: { locator: { displayLabel: 'happier-dev (GitHub)' } }, kindId: 'issue', fields },
        inputFields: [{ path: 'instance.locator.displayLabel', title: 'Connected Account' }, { path: 'fields.title', title: 'Title' }] });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    expect(screen.getTextContent()).toContain('happier-dev (GitHub)');
    const labels = screen.findAllByType(TechnicalDetailsDisclosure).flatMap(node => (node.props as React.ComponentProps<typeof TechnicalDetailsDisclosure>).lines.map(line => line.label));
    expect(labels).toEqual(expect.arrayContaining(['Instance', 'Fields']));
    expect(labels).not.toContain('V');
});

it('R21-D2: never leads a contributed Action\'s review with a serialized structure or an id nothing names', async () => {
    const repository = { v: 1, repositoryId: '1474884453', owner: 'hapier-qa', name: 'field-guide-site' };
    // The preview status Action's declared review fields, as its manifest lists them.
    const presentation = describeApprovalRequestFields({ kind: 'plugin_target_action', status: 'open', secretInputPaths: [],
        input: { deploymentId: 'cmx07muhg0001abcdefghijkl', expectedHeadSha: '3637d32', status: 'success',
            sourceConfig: { repository } },
        inputFields: [{ path: 'deploymentId', title: 'Deployment' }, { path: 'sourceConfig.repository', title: 'Repository' },
            { path: 'status', title: 'Status' }] });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    const lead = screen.getTextContent();
    expect(lead).toContain('success');
    expect(lead).not.toContain('{"v":1');
    expect(lead).not.toContain('cmx07muhg0001abcdefghijkl');
    // Still present, one disclosure away.
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain('cmx07muhg0001abcdefghijkl');
    expect(screen.getTextContent()).toContain('1474884453');
});

it('leads with the changed value: the Session that asked stays in Technical details on the card and the page alike', async () => {
    const home = await upsertServerProfile({ name: 'Personal', serverUrl: 'https://asking-session-target.test' });
    profiles.push(home.id);
    const askingId = 'cmw-asking-session';
    const otherId = 'cmw-other-session';
    await act(async () => {
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'account' } });
        storage.getState().applySessions([
            createSessionFixture({ id: askingId, serverId: home.id, metadata: { ...createSessionFixture().metadata!, name: 'Review the storefront guide' } }),
            createSessionFixture({ id: otherId, serverId: home.id, metadata: { ...createSessionFixture().metadata!, name: 'Checkout page review' } }),
        ]);
    });
    const ask = (sessionId: string) => ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId: askingId }, actionId: 'session.title.set', summary: 'Rename session',
        actionArgs: { sessionId, title: 'Storefront copy, final pass' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' }, sessionId: askingId,
            serverId: home.id, actionId: 'session.title.set', requestId: `rename-${sessionId}` } });
    for (const anatomy of ['card', 'page'] as const) {
        const own = ask(askingId);
        const screen = await renderScreen(<ActionApprovalFieldsCard request={own} presentation={describeApprovalActionFields(own)}
            anatomy={anatomy} serverId={home.id} />);
        // The fade on a card can never hide the new title behind a row naming the Session the card sits in.
        expect(screen.getTextContent()).toContain('Storefront copy, final pass');
        expect(screen.getTextContent()).not.toContain('Review the storefront guide');
        const other = ask(otherId);
        const elsewhere = await renderScreen(<ActionApprovalFieldsCard request={other} presentation={describeApprovalActionFields(other)}
            anatomy={anatomy} serverId={home.id} />);
        // Another Session is what the request changes: it stays readable by its name.
        expect(elsewhere.getTextContent()).toContain('Checkout page review');
    }
});

it('names a plugin-contributed Action\'s Session and Machine operands like a host Action\'s, their ids in Technical details', async () => {
    const home = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://contributed-session-operand.test' });
    profiles.push(home.id);
    const sessionId = 'cmwtf8xvw00kpb5mc5l17bbqa';
    const machineId = 'opaque-contributed-machine';
    await act(async () => {
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'account' },
            machineListByServerId: { [home.id]: [createMachineFixture({ id: machineId,
                metadata: { ...createMachineFixture().metadata!, displayName: 'Studio' } })] },
            concurrentSessionListCacheByServerId: { [home.id]: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } } } });
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: home.id,
            metadata: { ...createSessionFixture().metadata!, name: 'Checkout page review' } })]);
    });
    // The stored request as the Channels plugin's session pull request binding writes it: no declared review fields.
    const target = (input: Record<string, string>) => describeApprovalRequestFields({ kind: 'plugin_target_action', status: 'open',
        secretInputPaths: [], input });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={target({ kind: 'attach', sessionId, machineId })} />);
    expect(screen.getTextContent()).toContain('Checkout page review');
    expect(screen.getTextContent()).toContain('Studio');
    expect(screen.getTextContent()).not.toContain(sessionId);
    expect(screen.getTextContent()).not.toContain(machineId);
    await expandDisclosureAsync(screen.findAllByTestId('approvals.technical-details'));
    expect(screen.getTextContent()).toContain(sessionId);
    expect(screen.getTextContent()).toContain(machineId);

    // A Session the viewer cannot open reads by where it lives, never by its id.
    const hidden = 'cmw-session-not-visible';
    const unnamed = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
        presentation={target({ kind: 'attach', sessionId: hidden })} />);
    expect(unnamed.getTextContent()).toContain(describeUnnamedApprovalSession('Approval Home'));
    expect(unnamed.getTextContent()).not.toContain(hidden);

    // A pressed contribution (`action.invoke`) with its declared review fields reads the same way.
    const pressed = describeApprovalActionFields({ actionId: 'action.invoke',
        actionArgs: { action: { pluginId: 'happier.channels', localId: 'session-pull-request-binding-v1' }, input: { kind: 'attach', sessionId } },
        preview: { contributedAction: { title: 'Manage session pull request binding', fields: [{ path: 'sessionId', title: 'Session' }] } } });
    const invoked = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id} presentation={pressed} />);
    expect(invoked.getTextContent()).toContain('Checkout page review');
    expect(invoked.getTextContent()).not.toContain(sessionId);
});

it('names a Workflow, a Run and a Project by what they are, and says so neutrally when they cannot be read', async () => {
    // The real sync runtime owns exact header and Run reads; its transport is the boundary stubbed below.
    await import('@/sync/syncEngine');
    const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
    const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
    const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
    const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
    const { formatRelativeTimeShort } = await import('@/utils/time/formatShortRelativeTime');
    const home = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://workflow-operands.test' });
    profiles.push(home.id);
    const scope = { serverId: home.id, accountId: 'account' };
    const active = await activateStorageAccountScope(scope);
    // The Home's reads are the network boundary: anything not already in the stores settles as unread.
    let homeReads = 0;
    vi.stubGlobal('fetch', async () => { homeReads += 1; throw new Error('offline'); });
    try {
        const definitionId = '33333333-3333-4333-8333-333333333333';
        const runId = 'run-nightly';
        const startedAt = Date.now() - 2 * 60 * 60_000;
        await act(async () => {
            storage.setState({ settingsScope: scope });
            storage.getState().applyArtifacts([{ id: definitionId, title: null, isDecrypted: true, ownerAccountId: 'account', access: 'owner',
                rawHeader: { kind: 'workflow-definition.v1', definitionId, metadata: { title: 'Nightly triage' },
                    revision: { headerVersion: 1, bodyVersion: 1 } },
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } as never]);
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: runId,
                createdAt: new Date(startedAt).toISOString() }), { kind: 'available', value: { title: 'Nightly triage' } })], scope);
            applyProjectAccountRowsFixture(storage, { organizations: [{ key: { kind: 'project-organization', serverId: home.id,
                projectKey: 'payments' }, revision: 1, value: { label: 'Payments service' } }] });
        });
        const project = { key: { projectKey: 'payments' }, value: { label: 'Payments service' } };
        const read = async (actionId: 'workflow.definition.delete' | 'workflow.run.cancel' | 'workflow.run.start', actionArgs: Record<string, unknown>) => {
            const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
                presentation={describeApprovalActionFields({ actionId, actionArgs: getActionSpec(actionId).inputSchema.parse(actionArgs) })} />);
            return screen;
        };
        const workflow = await read('workflow.definition.delete', { definitionId });
        expect(workflow.getTextContent()).toContain('Nightly triage');
        expect(workflow.getTextContent()).not.toContain(definitionId);
        await expandDisclosureAsync(workflow.findAllByTestId('approvals.technical-details'));
        expect(workflow.getTextContent()).toContain(definitionId);

        // The READY309 start request's own arguments: its Run id is preallocated, so nothing reads it and it is not shown.
        const newRunId = '344a1e73-9fd5-46a9-8287-daee97bad1d2';
        const readsBeforeStart = homeReads;
        const start = await read('workflow.run.start', { runId: newRunId,
            source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } } });
        expect(start.getTextContent()).toContain('Nightly triage');
        expect(start.getTextContent()).not.toContain(newRunId);
        await expandDisclosureAsync(start.findAllByTestId('approvals.technical-details'));
        expect(start.getTextContent()).toContain(newRunId);
        expect(homeReads).toBe(readsBeforeStart);

        const run = await read('workflow.run.cancel', { runId, expectedRevision: 1 });
        expect(run.getTextContent()).toContain(`Nightly triage · ${formatRelativeTimeShort(startedAt, Date.now())}`);
        expect(run.getTextContent()).not.toContain(runId);

        const unreadWorkflow = await read('workflow.definition.delete', { definitionId: '44444444-4444-4444-8444-444444444444' });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        // An unread reference keeps its slot with an em dash and one quiet reason; its id stays in Technical details.
        expect(unreadWorkflow.getTextContent()).toContain(t('approvals.referenceNameUnavailable'));
        expect(unreadWorkflow.getTextContent()).not.toContain('44444444-4444-4444-8444-444444444444');
        const unreadRun = await read('workflow.run.cancel', { runId: 'run-not-visible', expectedRevision: 1 });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(unreadRun.getTextContent()).toContain(t('approvals.referenceNameUnavailable'));
        expect(unreadRun.getTextContent()).not.toContain('run-not-visible');

        // A Project key reads by the Project's name on any Action, a plugin's included.
        const projects = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
            presentation={describeApprovalRequestFields({ kind: 'plugin_target_action', status: 'open', secretInputPaths: [],
                input: { projectKey: project.key.projectKey } })} />);
        expect(projects.getTextContent()).toContain(project.value.label);
        expect(projects.getTextContent()).not.toContain(project.key.projectKey);
        const hidden = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={home.id}
            presentation={describeApprovalRequestFields({ kind: 'plugin_target_action', status: 'open', secretInputPaths: [],
                input: { projectKey: 'project-not-visible' } })} />);
        expect(hidden.getTextContent()).toContain(t('approvals.referenceNameUnavailable'));
        expect(hidden.getTextContent()).not.toContain('project-not-visible');
    } finally {
        active.dispose();
    }
});

it('keeps the invoking Home and the viewer\'s own Account out of the facts, one disclosure away (R16-D9)', async () => {
    const { demoteSelfReferences } = await import('./ActionApprovalFieldsCard');
    const presentation = describeApprovalActionFields({ actionId: 'account.delete',
        actionArgs: { serverId: 'home-a', accountId: 'viewer' } });
    const shown = (rows: typeof presentation.rows) => rows.filter(row => !(row.kind === 'value' && row.technical))
        .map(row => row.kind === 'value' ? row.reference?.kind : row.kind);
    expect(shown(presentation.rows)).toEqual(['home', 'account']);
    // Someone else's Account, or another Home, is a fact the person needs.
    expect(shown(demoteSelfReferences(presentation, 'home-b', { serverId: 'home-b', accountId: 'other' }).rows))
        .toEqual(['home', 'account']);
    expect(shown(demoteSelfReferences(presentation, 'home-a', { serverId: 'home-a', accountId: 'viewer' }).rows)).toEqual([]);
    // A Home the Action acts on is its operand, not the invocation context: it stays even when it is this Home.
    const operand = describeApprovalActionFields({ actionId: 'home.reachNudge.dismiss', actionArgs: { homeServerId: 'home-a' } });
    expect(shown(demoteSelfReferences(operand, 'home-a', { serverId: 'home-a', accountId: 'viewer' }).rows)).toEqual(['home']);
});
