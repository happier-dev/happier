import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import type { Socket } from 'socket.io-client';
import { randomUUID } from '@/platform/randomUUID';

// Network, platform and navigation are boundaries; Artifact storage and presentation stay real.
installApprovalCommonModuleMocks();
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
const replayBoundaries: ReturnType<typeof installDisconnectedServerSocketBoundary>[] = [];

/** Persist at the HTTP boundary so exact reads and startup list sync see the same record. */
async function storePluginApproval(request: ReturnType<typeof TargetActionApprovalRequestV1Schema.parse>): Promise<string> {
    const artifactId = randomUUID();
    // A daemon-created approval has no deciding-device revision provenance.
    const created = await account.home.artifacts(account.serverId).handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({ id: artifactId,
            header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(request)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(created?.ok).toBe(true);
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
    let artifactId = '';
    let request: ReturnType<typeof TargetActionApprovalRequestV1Schema.parse>;
    const outgoing: SocketRpcRequestPayload[] = [];
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { ok: true, result: {} };
            outgoing.push(payload);
            const settled = TargetActionApprovalRequestV1Schema.parse({ ...request,
                status: response === 'settled-success' ? 'executed' : 'failed', updatedAtMs: 3,
                decision: { kind: 'approve', decidedAtMs: 2 },
                execution: response === 'settled-success' ? { executedAtMs: 3, ok: true, result: { published: true } }
                    : { executedAtMs: 3, ok: false, errorCode: 'plugin_action_outcome_unknown', error: 'Plugin action invocation was aborted' } });
            // The daemon writes at the Home boundary; no socket echo or
            // deciding-device store publication supplies the settlement.
            const committed = await account.home.artifacts(account.serverId).handle(`/v1/artifacts/${artifactId}`, {
                method: 'POST', body: JSON.stringify({ expectedHeaderVersion: 1, expectedBodyVersion: 1,
                    header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(settled)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(settled) }),
                }),
            });
            expect(committed?.ok).toBe(true);
            expect(await committed?.json()).toMatchObject({ success: true });
            return response !== 'refused'
                ? { ok: false, error: 'RPC_REQUEST_CANCELLED' }
                : { ok: true, result: { ok: false, errorCode: 'plugin_action_outcome_unknown', error: 'Plugin action invocation was aborted' } };
        });
    });
    await account.restore({ serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    request = TargetActionApprovalRequestV1Schema.parse({
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
    artifactId = await storePluginApproval(request);
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    await screen.pressByTestIdAsync('approvals.approve');
    const { Modal } = await import('@/modal');
    expect(outgoing).toHaveLength(1);
    // A decision may execute an arbitrary approved Action. The setup budget
    // cannot become a second deadline on that Action after dispatch.
    expect(outgoing[0]?.timeoutMs).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    if (response === 'settled-success') {
        expect(screen.getTextContent()).toContain('approvals.status.executed');
        expect(Modal.alert).not.toHaveBeenCalled();
    } else {
        expect(screen.getTextContent()).toContain('approvals.status.failed');
        // RU2 R52: the failure alert must retain the recorded effect's typed cause.
        expect(Modal.alert).toHaveBeenCalledWith(expect.anything(), 'approvals.failureGeneric', expect.any(Array));
        const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
        const details = buttons?.find(button => button.text === 'approvals.technicalDetails');
        expect(details).toBeDefined();
        details?.onPress?.();
        expect(Modal.alert).toHaveBeenLastCalledWith('approvals.technicalDetails', 'plugin_action_outcome_unknown');
    }
});

it.each(['approve', 'reject'] as const)('routes plugin %s from the creator profile through this device profile for the same Home', async decision => {
    const outgoing: SocketRpcRequestPayload[] = [];
    const outgoingHomes: string[] = [];
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
            if (event === SOCKET_RPC_EVENTS.CALL) {
                outgoing.push(payload);
                outgoingHomes.push(new URL(serverUrl!).origin);
            }
            return { ok: true, result: { ok: true } };
        });
    });
    await account.restore({ serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
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
    const { resolveApprovalReplayRoute } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(resolveApprovalReplayRoute(request)).toEqual({ serverId: account.serverId,
        serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' });
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(outgoing).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
        params: { artifactId, decision,
            serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' } })]);
    expect(outgoingHomes).toEqual(['https://provider-settings-account.test']);
    // A portable identity unavailable on this device never falls back to creator-local routing.
    const wrongRequest = TargetActionApprovalRequestV1Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'srv_other_home' } });
    const wrongArtifactId = await storePluginApproval(wrongRequest);
    const wrongHome = await renderScreen(<ApprovalDetailScreen artifactId={wrongArtifactId} />);
    expect(wrongHome.findByTestId(`approvals.${decision}`)).not.toBeNull();
    expect(wrongHome.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(true);
    await wrongHome.pressByTestIdAsync(`approvals.${decision}`);
    expect(outgoing).toHaveLength(1);
});

afterEach(async () => {
    standardCleanup();
    await account.reset();
    for (const boundary of replayBoundaries.splice(0)) boundary.dispose();
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
});

it.each(['approve', 'reject'] as const)('updates plugin %s routing when the matching Home arrives and retires without replacing the cached Artifact', async decision => {
    const outgoing: SocketRpcRequestPayload[] = [];
    const outgoingHomes: string[] = [];
    const configureSocket = (socket: Socket, serverUrl?: string) => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
            if (event === SOCKET_RPC_EVENTS.CALL) {
                outgoing.push(payload);
                outgoingHomes.push(new URL(serverUrl!).origin);
            }
            return { ok: true, result: { ok: true } };
        });
    };
    installDisconnectedServerSocketBoundary(configureSocket);
    await account.restore({ serverIdentityId: 'srv_artifact_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
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
    expect(outgoing).toEqual([]);
    vi.mocked(Modal.alert).mockClear();

    const profiles = await import('@/sync/domains/server/serverProfiles');
    let replayServerId = '';
    await act(async () => {
        replayServerId = await account.addHome({ serverUrl: 'https://plugin-approval-replay.test',
            name: 'Replay Home', accountId: 'account-a', serverIdentityId: 'srv_arriving_plugin_home', active: false });
        const home = account.home.findByServerUrl('https://plugin-approval-replay.test')!;
        replayBoundaries.push(installDisconnectedServerSocketBoundary(configureSocket, {
            serverUrl: home.serverUrl, token: home.token!,
        }));
        await account.publishMachines(replayServerId, [createMachineFixture({ id: 'machine-exact' })]);
    });
    expect(storage.getState().artifacts[artifactId]).toBe(cached);
    await vi.waitFor(() => {
        expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
        expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
    });
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(outgoing).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
        params: { artifactId, decision,
            serverIdentityId: 'srv_arriving_plugin_home', originServerId: 'cli-A' } })]);
    expect(outgoingHomes).toEqual(['https://plugin-approval-replay.test']);

    await act(async () => { await profiles.removeServerProfile(replayServerId); });
    expect(storage.getState().artifacts[artifactId]).toBe(cached);
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(outgoing).toHaveLength(1);
    expect(Modal.alert).not.toHaveBeenCalled();
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
