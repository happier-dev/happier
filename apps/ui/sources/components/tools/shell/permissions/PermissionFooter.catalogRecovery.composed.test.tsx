import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { McpServerCatalogRowMutationV1Schema, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { NativePermissionChoicesV1Schema } from '@happier-dev/protocol/sessions/permissions/nativeChoicesV1';
import { createDeferred, createTestSessionTranscriptSource, makeToolCall, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

installPermissionShellCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
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
const { ToolView } = await import('../views/ToolView');
const { ToolTimelineRow } = await import('../views/ToolTimelineRow');
const { ToolFullView } = await import('../views/ToolFullView');
const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
const { storage } = await import('@/sync/domains/state/storage');
// Load the executable graph before entering the journey's behavior assertions.
await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(standardCleanup);

it.each([
    { surface: 'card', fails: false },
    { surface: 'card', fails: true },
    { surface: 'timeline', fails: true },
    { surface: 'details', fails: true },
] as const)('settles Always allow on the $surface after the native answer (fails=$fails)', async ({ surface, fails }) => {
    await homes.reset();
    nativeTransport.mockReset();
    const fixtureId = `mcp-recovery-${surface}-${fails}`;
    const serverId = await homes.addHome({ name: fixtureId, serverUrl: `https://${fixtureId}.test`,
        serverIdentityId: fixtureId, accountId: 'alice', currentAccount: true });
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'mutate', item: { serverId: 'docs' },
        serverTitle: 'Docs', toolTitle: 'Update docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    const nativeChoices = NativePermissionChoicesV1Schema.parse({ requirementId: 'mcp-occurrence', source: 'native-test', choices: [
        { id: 'once', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true } },
        { id: 'remember', label: 'Always allow', decision: 'approved', scope: 'localPersistent', response: { approved: true },
            followUp: { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { mutate: 'allow' } } } },
    ] });
    const request = { tool: 'mcp__docs__mutate', arguments: {}, createdAt: 1, turnId: 'mcp-turn', mcpTool: identity, nativeChoices };
    let session = createSessionFixture({ id: fixtureId, serverId, active: true,
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
    const finishSave = createDeferred<void>();
    // Hold the actual catalog HTTP boundary open while the Session acknowledges the native answer.
    // Staging injects a 503 only for the first POST, after the tool has already completed.
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: async input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        expect(mutation.expectedRevision).toBe(revision);
        saveAttempts++;
        if (saveAttempts === 1) {
            await finishSave.promise;
            if (fails) return { status: 503, body: { error: 'service_unavailable' } };
        }
        if (mutation.content?.t !== 'plain') throw new Error('Expected a plain catalog storage write');
        catalog = McpServerCatalogV1Schema.parse(mutation.content.v);
        revision++;
        return { body: { status: 'updated', revision, cursor: revision } };
    } });
    const source = createTestSessionTranscriptSource({ sessionId: session.id, serverId,
        interaction: { canApprovePermissions: true, canSendMessages: true },
        actions: createAppSessionTranscriptActions(session.id, serverId) });
    const nativeChoice = { requirementId: 'mcp-occurrence', choiceId: 'remember' };
    const view = (settled: boolean) => {
        const tool = makeToolCall({
            name: request.tool, createdAt: 1,
            state: settled ? 'completed' : 'running',
            completedAt: settled ? 2 : null,
            result: settled ? { content: [{ type: 'text', text: 'QA_MCP_HYPHEN_OK' }] } : null,
            permission: { id: 'mcp-request', turnId: 'mcp-turn', status: settled ? 'approved' : 'pending',
                nativeChoices, mcpTool: identity, ...(settled ? { nativeChoice } : {}) },
        });
        const props = { tool, sessionId: session.id, serverId, metadata: null };
        if (surface === 'details') return <ToolFullView {...props} owningMessageId="tool-message" forcePermissionFooterInTranscript />;
        if (surface === 'timeline') return <ToolTimelineRow {...props} messageId="tool-message" forcePermissionPromptsInTranscript />;
        return <ToolView {...props} messageId="tool-message" forcePermissionPromptsInTranscript />;
    };
    const screen = await renderWithSessionTranscriptSource(view(false), source);
    await screen.pressByTestIdAsync('permission-footer.choice.remember');
    await waitForHomeGovernance(() => expect(saveAttempts).toBe(1));
    await screen.update(view(true));
    const showedSaving = screen.findHostByTestId('permission-footer.always-allow-settled') !== null
        && screen.getTextContent().includes('Saving');
    expect(screen.findHostByTestId('permission-footer.choice.remember')).toBeNull();
    // The settled line says the decision and its save state; the row header does not repeat it.
    if (surface === 'timeline') {
        expect(screen.findHostByTestId('permission-footer.always-allow-settled')).not.toBeNull();
        expect(screen.findHostByTestId('tool-timeline-row-native-answer')).toBeNull();
    }
    expect(nativeTransport).toHaveBeenCalledTimes(1);
    finishSave.resolve();

    if (fails) {
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('permission-footer.always-allow-retry')).not.toBeNull();
            expect(screen.getTextContent()).toContain('Couldn’t save');
        });
        expect(showedSaving).toBe(true);
        await screen.unmount();
        // Reopening the real tool view restores the request-owned receipt.
        const reopened = await renderWithSessionTranscriptSource(view(true), source);
        expect(reopened.findHostByTestId('permission-footer.always-allow-retry')).not.toBeNull();
        await reopened.pressByTestIdAsync('permission-footer.always-allow-retry');
        await waitForHomeGovernance(() => {
            expect(reopened.findHostByTestId('permission-footer.always-allow-retry')).toBeNull();
            expect(reopened.getTextContent()).toContain('saved in Docs');
        });
    } else {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('saved in Docs'));
        expect(screen.findHostByTestId('permission-footer.always-allow-retry')).toBeNull();
    }
    expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { mutate: 'allow' } } });
    expect(saveAttempts).toBe(fails ? 2 : 1);
    expect(nativeTransport).toHaveBeenCalledTimes(1);
});
