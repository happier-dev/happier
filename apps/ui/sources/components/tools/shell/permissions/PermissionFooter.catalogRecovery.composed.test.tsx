import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { McpServerCatalogRowMutationV1Schema, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { NativePermissionChoicesV1Schema } from '@happier-dev/protocol/sessions/permissions/nativeChoicesV1';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

installPermissionShellCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    text: async () => {
        const text = await vi.importActual<typeof import('@/text')>('@/text');
        await text.preloadTranslations('en');
        text.setPreferredLanguageFromSettings('en');
        return text;
    },
});
installDisconnectedServerSocketBoundary();
const nativeTransport = vi.hoisted(() => vi.fn<(params: Readonly<{ method: string; payload: unknown }>) => Promise<unknown>>());
// Only the remote Agent RPC transport is replaced; native-choice admission and the catalog Action stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({ sessionRpcWithServerScope: params => nativeTransport(params) as never })(importOriginal);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { PermissionFooter } = await import('./PermissionFooter');
const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
const { storage } = await import('@/sync/domains/state/storage');
// Load the executable graph before entering the journey's behavior assertions.
await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(standardCleanup);

it('keeps a failed Always allow save visible after remount and retries storage without answering the native request again', async () => {
    await homes.reset();
    nativeTransport.mockReset();
    const serverId = await homes.addHome({ name: 'MCP recovery', serverUrl: 'https://mcp-recovery.test',
        serverIdentityId: 'mcp-recovery', accountId: 'alice', currentAccount: true });
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'mutate', item: { serverId: 'docs' },
        serverTitle: 'Docs', toolTitle: 'Update docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    const nativeChoices = NativePermissionChoicesV1Schema.parse({ requirementId: 'mcp-occurrence', source: 'native-test', choices: [
        { id: 'once', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true } },
        { id: 'remember', label: 'Always allow', decision: 'approved', scope: 'localPersistent', response: { approved: true },
            followUp: { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { mutate: 'allow' } } } },
    ] });
    const request = { tool: 'McpTool', arguments: {}, createdAt: 1, turnId: 'mcp-turn', mcpTool: identity, nativeChoices };
    let session = createSessionFixture({ id: 'mcp-recovery-session', serverId, active: true,
        agentState: { requests: { 'mcp-request': request } } });
    homes.answer(serverId, `GET /v2/sessions/${session.id}`, { select: () => ({ body: createPlainSessionByIdResponseFixture(session) }) });
    storage.getState().applySessions([session]);
    nativeTransport.mockImplementation(async params => {
        expect(params.method).toBe(RPC_METHODS.SESSION_PERMISSION_RESPOND);
        expect(params.payload).toMatchObject({ id: 'mcp-request', turnId: 'mcp-turn',
            nativeChoice: { requirementId: 'mcp-occurrence', choiceId: 'remember' } });
        session = createSessionFixture({ ...session, agentState: { requests: {}, completedRequests: {
            'mcp-request': { ...request, completedAt: 2, status: 'approved',
                nativeChoice: { requirementId: 'mcp-occurrence', choiceId: 'remember' } },
        } } });
        storage.getState().applySessions([session]);
        return { ok: true };
    });
    let revision = 1;
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
        stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] });
    let saveAttempts = 0;
    homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: {
        status: 'present', revision, content: { t: 'plain', v: catalog },
    } }) });
    // The first storage CAS fails after the native answer has been accepted; no internal owner is stubbed.
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        expect(mutation.expectedRevision).toBe(revision);
        saveAttempts++;
        if (saveAttempts === 1) return { body: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected a plain catalog storage write');
        catalog = McpServerCatalogV1Schema.parse(mutation.content.v);
        revision++;
        return { body: { status: 'updated', revision, cursor: revision } };
    } });
    const source = createTestSessionTranscriptSource({ sessionId: session.id, serverId,
        interaction: { canApprovePermissions: true, canSendMessages: true },
        actions: createAppSessionTranscriptActions(session.id, serverId) });
    const footer = (status: 'pending' | 'approved') => <PermissionFooter sessionId={session.id} serverId={serverId}
        toolName="McpTool" canApprovePermissions permission={{ id: 'mcp-request', turnId: 'mcp-turn', status,
            nativeChoices, mcpTool: identity }} />;
    const first = await renderWithSessionTranscriptSource(footer('pending'), source);
    await first.pressByTestIdAsync('permission-footer.choice.remember');
    await waitForHomeGovernance(() => {
        expect(first.findHostByTestId('permission-footer.always-allow-retry')).not.toBeNull();
        expect(first.getTextContent()).toContain('Couldn’t save');
    });
    expect(nativeTransport).toHaveBeenCalledTimes(1);
    expect(saveAttempts).toBe(1);
    await first.unmount();

    // A genuine new mounted footer restores the request-owned receipt, rather than receiving a controller snapshot.
    const remounted = await renderWithSessionTranscriptSource(footer('approved'), source);
    expect(remounted.findHostByTestId('permission-footer.always-allow-retry')).not.toBeNull();
    expect(remounted.getTextContent()).toContain('Couldn’t save');
    await remounted.pressByTestIdAsync('permission-footer.always-allow-retry');
    await waitForHomeGovernance(() => {
        expect(remounted.findHostByTestId('permission-footer.always-allow-retry')).toBeNull();
        expect(remounted.getTextContent()).toContain('saved in Docs');
    });
    expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { mutate: 'allow' } } });
    expect(saveAttempts).toBe(2);
    expect(nativeTransport).toHaveBeenCalledTimes(1);
});
