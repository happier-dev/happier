import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { APPROVAL_REQUEST_DECIDE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { act } from 'react-test-renderer';
import { randomUUID } from '@/platform/randomUUID';

// Network, platform and navigation are boundaries; Artifact storage and presentation stay real.
installApprovalCommonModuleMocks();
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
const decisionPath = `/v1/actions/${APPROVAL_REQUEST_DECIDE_ACTION_ID_V1}`;
const decisionSpec = getActionSpec(APPROVAL_REQUEST_DECIDE_ACTION_ID_V1);

function servePluginDecision(serverId: string, respond: (request: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>)
    => HomeDomainAnswer | Promise<HomeDomainAnswer>) {
    account.home.answer(serverId, `POST ${decisionPath}`, {
        select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'machine-exact' });
            decisionSpec.inputSchema.parse(request.input);
            return respond(request);
        },
    });
}

function decisionRequests() {
    return account.home.requestsFor(decisionPath).map(request => ({
        home: request.serverUrl,
        input: ExternalActionRequestEnvelopeV1Schema.parse(request.input).input,
    }));
}

function acceptedDecision(decision: 'approve' | 'reject') {
    return (request: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>) => ({
        body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: decisionSpec.id, requestId: request.requestId,
            execution: { ok: true, result: { ok: true, status: decision === 'approve' ? 'approved' : 'rejected' } } }),
    });
}

async function persistPluginApproval(serverId: string, artifactId: string,
    request: ReturnType<typeof TargetActionApprovalRequestV1Schema.parse>) {
    // A daemon-created approval has no deciding-device revision provenance.
    const created = await account.home.artifacts(serverId).handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({ id: artifactId,
            header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(created?.ok).toBe(true);
}

/** Persist at the HTTP boundary so exact reads and startup list sync see the same record. */
async function storePluginApproval(request: ReturnType<typeof TargetActionApprovalRequestV1Schema.parse>): Promise<string> {
    const artifactId = randomUUID();
    await persistPluginApproval(account.serverId, artifactId, request);
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(account.serverId);
    try {
        const artifact = await context.fetchArtifact(artifactId);
        if (!artifact) throw new Error('Expected the persisted plugin approval');
        storage.getState().updateArtifact(artifact);
        return artifactId;
    } finally { context.dispose(); }
}

it.each([undefined, 'srv_other_home'])('withholds plugin decisions when its replay Home is unresolved (%s)', async serverIdentityId => {
    await account.restore({ serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'stack_agent-qa-prs-issues__id_default', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
            serverId: 'stack_agent-qa-prs-issues__id_default', ...(serverIdentityId ? { serverIdentityId } : {}), accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'unresolved-plugin-home' },
    });
    const artifactId = await storePluginApproval(request);
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} serverId={account.serverId} />);
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(true);
});

it.each(['refused', 'lost', 'settled-success'] as const)('shows the settled plugin effect after a %s decision response without replaying it', async response => {
    await account.restore({ currentAccount: true, serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'cli-A', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'cli-A', serverIdentityId: 'srv_plugin_home', accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'plugin-settled-failure' },
    });
    const artifactId = await storePluginApproval(request);
    servePluginDecision(account.serverId, async decision => {
        expect(decision.input).toEqual({ artifactId, decision: 'approve', serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' });
        const settled = TargetActionApprovalRequestV1Schema.parse({ ...request,
            status: response === 'settled-success' ? 'executed' : 'failed', updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: response === 'settled-success' ? { executedAtMs: 3, ok: true, result: { published: true } }
                : { executedAtMs: 3, ok: false, errorCode: 'plugin_action_outcome_unknown', error: 'Plugin action invocation was aborted' } });
        // Only the remote daemon settles the Artifact. A lost response is the Home relay's empty 502.
        const committed = await account.home.artifacts(account.serverId).handle(`/v1/artifacts/${artifactId}`, {
            method: 'POST', body: JSON.stringify({ expectedHeaderVersion: 1, expectedBodyVersion: 1,
                header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(settled)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(settled) }),
            }),
        });
        expect(committed?.ok).toBe(true);
        expect(await committed?.json()).toMatchObject({ success: true });
        return response === 'refused'
            ? { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: decisionSpec.id, requestId: decision.requestId,
                execution: { ok: false, errorCode: 'plugin_action_outcome_unknown', error: 'Plugin action invocation was aborted' } }) }
            : { status: 502 };
    });
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    await screen.pressByTestIdAsync('approvals.approve');
    const { Modal } = await import('@/modal');
    expect(decisionRequests()).toHaveLength(1);
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(Modal.alert).not.toHaveBeenCalled();
    if (response === 'settled-success') {
        expect(screen.getTextContent()).toContain('approvals.status.executed');
    } else {
        const text = screen.getTextContent();
        expect(text.split('approvals.status.failed')).toHaveLength(2);
        expect(text).toContain('errors.scmOutcomeUnknown');
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain('plugin_action_outcome_unknown');
        expect(decisionRequests()).toHaveLength(1);
    }
});

it.each(['approve', 'reject'] as const)('routes plugin %s from the creator profile through this device profile for the same Home', async decision => {
    await account.restore({ currentAccount: true, serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'cli-A', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'cli-A', serverIdentityId: 'srv_plugin_home', accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'plugin-approval-1' },
    });
    const artifactId = await storePluginApproval(request);
    servePluginDecision(account.serverId, acceptedDecision(decision));
    const { resolveApprovalReplayRoute } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(resolveApprovalReplayRoute(request)).toEqual({ serverId: account.serverId,
        serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' });
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(decisionRequests()).toEqual([{ home: 'https://provider-settings-account.test',
        input: { artifactId, decision, serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' } }]);
    // A portable identity unavailable on this device never falls back to creator-local routing.
    const wrongRequest = TargetActionApprovalRequestV1Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'srv_other_home' } });
    const wrongArtifactId = await storePluginApproval(wrongRequest);
    const wrongHome = await renderScreen(<ApprovalDetailScreen artifactId={wrongArtifactId} />);
    expect(wrongHome.findByTestId(`approvals.${decision}`)).not.toBeNull();
    expect(wrongHome.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(true);
    await wrongHome.pressByTestIdAsync(`approvals.${decision}`);
    expect(decisionRequests()).toHaveLength(1);
});

afterEach(async () => {
    standardCleanup();
    await account.reset();
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
});

it.each(['approve', 'reject'] as const)('updates plugin %s routing when the matching Home arrives and retires without replacing the cached Artifact', async decision => {
    await account.restore({ currentAccount: true, serverIdentityId: 'srv_artifact_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'cli-A', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'cli-A', serverIdentityId: 'srv_arriving_plugin_home', accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'plugin-approval-recovery' },
    });
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(account.serverId);
    let artifactId: string;
    try { artifactId = await context.createArtifact(buildTargetActionApprovalArtifactHeaderV1(request), JSON.stringify(request)); }
    finally { context.dispose(); }
    const { sync } = await import('@/sync/sync');
    const artifact = await sync.fetchArtifactWithBody(artifactId);
    expect(artifact).not.toBeNull();
    storage.getState().updateArtifact(artifact!);
    const cached = storage.getState().artifacts[artifactId];
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(decisionRequests()).toEqual([]);
    vi.mocked(Modal.alert).mockClear();

    const profiles = await import('@/sync/domains/server/serverProfiles');
    const bringReplayHomeOnline = async () => {
        let replayServerId = '';
        await act(async () => {
            replayServerId = await account.addHome({ serverUrl: 'https://plugin-approval-replay.test',
                name: 'Replay Home', accountId: 'account-a', serverIdentityId: 'srv_arriving_plugin_home', active: false, currentAccount: true });
            await persistPluginApproval(replayServerId, artifactId, request);
            await account.publishMachines(replayServerId, [createMachineFixture({ id: 'machine-exact' })]);
            servePluginDecision(replayServerId, acceptedDecision(decision));
        });
        expect(storage.getState().artifacts[artifactId]).toBe(cached);
        await vi.waitFor(() => {
            expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
            expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
        });
        return replayServerId;
    };

    const replayServerId = await bringReplayHomeOnline();
    await act(async () => { await profiles.removeServerProfile(replayServerId); });
    expect(storage.getState().artifacts[artifactId]).toBe(cached);
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(decisionRequests()).toEqual([]);
    expect(Modal.alert).not.toHaveBeenCalled();

    await bringReplayHomeOnline();
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(decisionRequests()).toEqual([{ home: 'https://plugin-approval-replay.test',
        input: { artifactId, decision, serverIdentityId: 'srv_arriving_plugin_home', originServerId: 'cli-A' } }]);
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(screen.findByTestId(`approvals.${decision}`)).toBeNull();
});

it('presents a plugin Action by its retained human summary without exposing routing ids as copy', async () => {
    await account.restore({ machines: [] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'qa.collection-detail/actions/set-complete',
        input: { completed: true }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'private-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
        summary: 'Change review completion',
    });
    const artifactId = await storePluginApproval(request);
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    const text = screen.getTextContent();
    expect(text).toContain('Change review completion');
    expect(text).toContain('true');
    for (const raw of ['qa.collection-detail', 'set-complete', 'development', 'private-root']) expect(text).not.toContain(raw);
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(false);
});
