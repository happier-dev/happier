import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { createDeferred, renderScreen, standardCleanup, createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { applyMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readPendingCapabilityApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema,
    PromptLibraryRecordV1Schema, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createReachRulesController } from '@/sync/domains/capabilities/reach/useReachRulesState';
import { createCapabilityEnableApprovalController } from './capabilityEnableApproval';
import { reachRulesToDraftsV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { SkillsRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const machineTransport = vi.hoisted(() => vi.fn<(request: { method: string; payload: unknown }) => Promise<unknown>>());
// The daemon network hop is external. Its replay runs the real Protocol owner,
// P2 metadata ports, strict approval producer and Artifact CAS beneath it.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));
installApprovalCommonModuleMocks({ storage: original => original(), text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { sessionCapabilityTranslations } = await import('@/text/translations/sessionCapabilityTranslations');
    return createTextModuleMock({ translate: (key, params) => {
        const text = sessionCapabilityTranslations.en;
        if (key === 'capabilities.session.alwaysFor') return text.alwaysFor(params as { agent: string; place: string });
        if (key === 'capabilities.session.always') return text.always(params as { place: string });
        if (key === 'capabilities.session.wants') return text.wants(params as { agent: string; item: string });
        return key;
    } });
} });
await loadSyncSingletonForTests();
const { createDefaultActionExecutor, isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useCapabilityEnableApproval } = await import('./useCapabilityEnableApproval');
const { CapabilityEnableApprovalView, describeCapabilityEnableSettled } = await import('./CapabilityEnableApprovalView');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiSessionCapabilityActionDeps } = await import('@/sync/ops/actions/sessionCapabilityActionDeps');
const { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice } = await import('./sessionCapabilityApplyNotice');
const { McpAlwaysAllowDecision } = await import('@/components/tools/shell/permissions/McpAlwaysAllowDecision');
const { PermissionPromptCard } = await import('@/components/tools/shell/permissions/PermissionPromptCard');
const { PermissionFooter } = await import('@/components/tools/shell/permissions/PermissionFooter');
const { ResolvedMcpToolIdentityV1Schema } = await import('@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1');
const { useMcpAlwaysAllow } = await import('@/components/tools/shell/permissions/useMcpAlwaysAllow');
const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
const { AgentStateSchema } = await import('@happier-dev/session-core/state');

it('retires all full controllers after 128 untouched MCP cards leave', async () => {
    const accountId = 'retirement-owner';
    const serverId = await homes.addHome({ name: 'Retirement Home', serverUrl: 'https://retirement.test', accountId });
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'write', item: { serverId: 'docs' }, serverTitle: 'Docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'write', source: 'server_default' } });
    // Observe strong registry entries without replacing any controller or domain logic.
    const insertions = vi.spyOn(Map.prototype, 'set');
    try {
        function Card({ id }: { id: number }) {
            useMcpAlwaysAllow({ requestId: `retirement-card-${id}`, identity, scope: { serverId, accountId }, canWriteCatalog: true,
                answerForSession: async () => { throw new Error('Untouched card must not answer'); } });
            return null;
        }
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            Array.from({ length: 128 }, (_, id) => React.createElement(Card, { key: id, id }))));
        const entries = insertions.mock.calls.flatMap(([key], index) => typeof key === 'string' && key.includes('retirement-card-')
            ? [{ map: insertions.mock.contexts[index] as Map<string, unknown>, key }] : []);
        expect(entries.length).toBeGreaterThanOrEqual(128);
        await act(async () => screen.tree.unmount());
        const retained = new Set(entries.filter(({ map, key }) => {
            const value = map.get(key);
            return value !== null && typeof value === 'object' && 'controller' in value;
        }).map(({ key }) => key));
        expect(retained.size).toBe(0);
    } finally { insertions.mockRestore(); }
});

beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); await loadSyncSingletonForTests(); machineTransport.mockReset(); });
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('keeps the native catalog failure visible after retirement and remounts a catalog-only retry', async () => {
    const accountId = 'native-mcp-owner';
    const serverId = await homes.addHome({ name: 'Native MCP Home', serverUrl: 'https://native-mcp.test', accountId });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'docs', name: 'docs', title: 'Docs', transport: 'http',
        remote: { url: 'https://docs.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] });
    let refuseSave = true; let pending = true; let answers = 0;
    homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } } }) });
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        if (refuseSave) return { body: { status: 'conflict', revision: 1 } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain catalog');
        catalog = mutation.content.v;
        return { body: { status: 'updated', revision: 2, cursor: 2 } };
    } });
    const followUp = { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } };
    const nativeChoices = { requirementId: 'occurrence', source: 'test-agent', choices: [{ id: 'remember', label: 'Remember',
        decision: 'approved' as const, scope: 'session' as const, response: { approved: true }, followUp }] };
    const mcpTool = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'write', item: { serverId: 'docs' }, serverTitle: 'Docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'write', source: 'server_default' } });
    const storedRequest = { tool: 'McpTool', arguments: {}, createdAt: 1, nativeChoices, mcpTool };
    const projection = createReducer();
    reducer(projection, [], AgentStateSchema.parse({ requests: { 'native-mcp': storedRequest } }));
    const readPermission = () => {
        const message = projection.messages.get(projection.toolIdToMessageId.get('native-mcp')!);
        if (!message?.tool?.permission?.mcpTool) throw new Error('Missing canonical MCP permission identity');
        return message.tool.permission;
    };
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
        sessionStatusGet: async () => ({ pendingRequests: pending ? [{ requestId: 'native-mcp', kind: 'permission', tool: 'McpTool',
            nativeChoices }] : [] }),
        sessionPermissionRespond: async () => { answers++; pending = false;
            reducer(projection, [], AgentStateSchema.parse({ completedRequests: { 'native-mcp': { ...storedRequest,
                completedAt: 2, status: 'approved', nativeChoice: { requirementId: 'occurrence', choiceId: 'remember' } } } }));
            return { ok: true }; },
        mcpServerAction: createMcpServerActionExecuteV1({
            readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                readRow: async () => McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
            mutate: async mutation => { if (refuseSave) return { status: 'conflict', revision: 1 };
                catalog = applyMcpServerCatalogMutationV1(catalog, mutation); return { status: 'updated', revision: 2, cursor: 2 }; },
            machine: async () => { throw new Error('Catalog consent never starts a process'); },
        }),
    });
    const source = createTestSessionTranscriptSource({ sessionId: 'session', serverId,
        interaction: { canSendMessages: true, canApprovePermissions: true }, actions: {
            respondToPermission: async ({ id, nativeChoice, turnId }) => {
                requireActionSuccess(await executor.execute('session.permission.respond', {
                    sessionId: 'session', requestId: id, nativeChoice,
                    ...(turnId ? { turnId } : {}),
                }, { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId }));
            },
            answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {},
        } });
    const footer = () => wrapWithSessionTranscriptSource(React.createElement(PermissionFooter, {
        sessionId: 'session', serverId, toolName: 'McpTool', canApprovePermissions: true, permission: readPermission(),
    }), source);
    let screen = await renderScreen(footer());
    await vi.waitFor(() => expect(screen.findByTestId('permission-footer.choice.remember')).toBeTruthy());
    await act(async () => { screen.pressByTestId('permission-footer.choice.remember'); });
    await vi.waitFor(() => expect(screen.findByTestId('permission-footer.always-allow-retry')).toBeTruthy());
    expect(pending).toBe(false);
    const settled = readPermission();
    expect(settled).toMatchObject({ mcpTool, nativeChoices, nativeChoice: { requirementId: 'occurrence', choiceId: 'remember' } });
    await act(async () => screen.tree.unmount());
    screen = await renderScreen(footer());
    await vi.waitFor(() => expect(screen.findByTestId('permission-footer.always-allow-retry')).toBeTruthy());
    refuseSave = false;
    await act(async () => { screen.pressByTestId('permission-footer.always-allow-retry'); });
    await vi.waitFor(() => expect(catalog.servers[0]?.tools?.overrides.write).toBe('allow'));
    expect(answers).toBe(1);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('capabilities.session.toolAsk.savedIn'));
});

it.each(['success', 'retry', 'sibling'] as const)('loads the MCP server default and saves Always allow after tray unmount (%s)', async mode => {
    const failsFirstSave = mode === 'retry';
    const accountId = `mcp-tray-owner-${mode}`;
    const serverId = await homes.addHome({ name: 'MCP Tray Home', serverUrl: `https://mcp-tray-${mode}.test`, accountId });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'docs', name: 'docs', title: 'Docs', transport: 'http',
        remote: { url: 'https://docs.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1,
        tools: { default: 'allow_read_only', overrides: {} } }], bindings: [] });
    let revision = 1;
    let refuseSave = failsFirstSave;
    homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }) });
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        if (refuseSave || mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain catalog');
        catalog = mutation.content.v;
        return { body: { status: 'updated', revision: ++revision, cursor: revision } };
    } });
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'docs', tool: 'write', item: { serverId: 'docs' }, serverTitle: 'Docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'write', source: 'server_default' } });
    const answered = createDeferred<void>();
    const acknowledge = createDeferred<void>();
    const scope = { serverId, accountId };
    let answers = 0;
    const source = createTestSessionTranscriptSource({ sessionId: 'session-mcp', serverId, navigate: () => {},
        interaction: { canSendMessages: true, canApprovePermissions: true }, actions: {
        respondToPermission: async response => {
            expect(response).toMatchObject({ id: 'mcp-tray', approved: true, decision: 'approved_for_session' });
            answers++; answered.resolve(); await acknowledge.promise;
        },
        answerUserAction: async () => { throw new Error('Unexpected user action'); },
        abort: async () => { throw new Error('Unexpected abort'); },
        submitMessage: async () => { throw new Error('Unexpected message'); },
    } });
    let screen = await renderScreen(wrapWithSessionTranscriptSource(React.createElement(PermissionPromptCard, {
        sessionId: 'session-mcp', request: { id: 'mcp-tray', kind: 'permission', createdAt: 1, tool: 'mcp__docs__write', arguments: {}, mcpTool: identity },
        metadata: { path: '/repo', host: 'MacBook', homeDir: '/home/tester', flavor: 'codex', machineId: 'machine' }, location: null, canApprovePermissions: true,
    }), source));
    await vi.waitFor(() => expect(screen.findByTestId('permission-footer.always-allow')).toBeTruthy());
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('capabilities.mcp.tools.defaultReadOnly'));
    expect(screen.findByTestId('permission-prompt-tool-settings')).toBeTruthy();
    await act(async () => { screen.pressByTestId('permission-footer.always-allow'); await answered.promise; });
    const sibling = mode === 'sibling' ? await renderScreen(React.createElement(Settled)) : null;
    await act(async () => { screen.tree.unmount(); });
    await act(async () => { acknowledge.resolve(); });
    // A later Details/transcript view sees the request's result without answering it twice.
    function Settled() {
        return React.createElement(McpAlwaysAllowDecision, { requestId: 'mcp-tray', identity, scope, canWriteCatalog: true, pending: false,
            answerForSession: async () => { throw new Error('Already answered'); }, renderDecision: () => null });
    }
    if (sibling) {
        await vi.waitFor(() => expect(sibling.getTextContent()).toContain('capabilities.session.toolAsk.savedIn'));
        await act(async () => sibling.tree.unmount());
    }
    screen = await renderScreen(React.createElement(Settled));
    if (failsFirstSave) {
        await vi.waitFor(() => expect(screen.findByTestId('permission-footer.always-allow-retry')).toBeTruthy());
        expect(catalog.servers[0]?.tools?.overrides.write).toBeUndefined();
        refuseSave = false;
        await act(async () => { screen.pressByTestId('permission-footer.always-allow-retry'); });
    }
    await vi.waitFor(() => expect(catalog.servers[0]?.tools?.overrides.write).toBe('allow'));
    expect(screen.findByTestId('permission-footer.always-allow-settled')).toBeTruthy();
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('capabilities.session.toolAsk.savedIn'));
    expect(answers).toBe(1);
});

it.each(['always', 'reject', 'cannot_resume', 'tray', 'tray_failed', 'tray_account_changed', 'remount', 'skill_revision'] as const)('uses the existing Agent approval with reason and a D33-qualified %s decision', async choice => {
    const skillRevision = choice === 'skill_revision';
    const tray = choice === 'tray' || choice === 'tray_failed' || choice === 'tray_account_changed' || skillRevision;
    // Each scenario owns its Account row history; a production snapshot must never accept a lower revision
    // just because the HTTP fixture has been reset for the next test.
    const accountId = `capability-owner-${choice}`;
    const serverId = await homes.addHome({ name: 'Capability Home', serverUrl: `https://capability-approval-${choice}.test`, accountId,
        serverIdentityId: 'srv_capability-home-identity' });
    let itemId = 'linear-id';
    if (skillRevision) {
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Linear', bundleSchemaId: 'skills.skill_md_v1' },
                body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                    contentBase64: Buffer.from('---\nname: linear\n---\nInstructions').toString('base64') }] }) });
            itemId = created.artifactId;
        } finally { account.dispose(); }
    }
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [createPlainMachineRowFixture({ id: 'machine', accountId })] });
    const sessionId = 'c123456789012345678901234';
    const metadata = { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'gemini', startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'gemini', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: choice === 'cannot_resume' ? 'unsupported' : 'supported', skillsLiveReload: 'unsupported' } } };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid Session owner fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { select: () => ({ body: { session: row } }) });
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
        row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'linear-id', name: 'linear', title: 'Linear', transport: 'http',
        remote: { url: 'https://linear.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'general', serverId: 'linear-id', target: { t: 'project', projectKey: 'happier' }, enabled: true, createdAt: 1, updatedAt: 1 },
            { id: 'except-gemini', serverId: 'linear-id', target: { t: 'project', projectKey: 'happier' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 }] });
    let revision = 1;
    let skillRecord: PromptLibraryRecordV1 & { key: 'skill-rules' } = { key: 'skill-rules', value: { v: 1,
        rules: catalog.bindings.map(({ serverId: _id, ...rule }) => ({ ...rule, skillId: itemId })) } };
    const readRules = () => skillRevision ? skillRecord.value.rules.map(({ skillId: _id, ...rule }) => rule)
        : catalog.bindings.map(({ serverId: _id, ...rule }) => rule);
    const attempts: (number | 'absent')[] = [];
    if (skillRevision) {
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
            { key: skillRecord.key, revision, content: { t: 'plain', v: skillRecord } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== skillRecord.key).map(key => ({ key, revision: 1, content: null })),
        ] } }) });
        homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, { select: input => {
            const mutation = PromptLibraryRowMutationV1Schema.parse(input);
            attempts.push(mutation.expectedRevision);
            if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain skill rules');
            const parsed = PromptLibraryRecordV1Schema.parse(mutation.content.v);
            if (parsed.key !== 'skill-rules') throw new Error('Expected skill-rules record');
            skillRecord = parsed;
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
    }
    let refuseRules = choice === 'tray_failed';
    homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }) });
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        if (refuseRules || mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account catalog');
        catalog = mutation.content.v;
        return { body: { status: 'updated', revision: ++revision, cursor: revision } };
    } });
    homes.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    const replaySettled = createDeferred<void>();
    const returnReplay = createDeferred<void>();
    machineTransport.mockImplementation(async request => {
        expect(request.method).toBe(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const replay = createActionExecutor(createActionExecutorBoundaryFixture({ ...createUiSessionCapabilityActionDeps(account),
                // This unsigned host-origin fixture uses the same captured Home/Account
                // currentness owner as the real UI executor; no signed-origin branch is replaced.
                isApprovalExecutionOriginCurrent: async ({ origin }) => {
                    account.assertCurrent();
                    return isApprovalExecutionOriginCurrentForAccountContext({ origin,
                        accountServerId: account.serverId, accountId: account.accountId });
                },
                approvalsGet: async ({ artifactId }) => ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)),
                approvalsUpdate: async ({ artifactId, request: next }) => {
                    const current = homes.artifacts(serverId).read(artifactId);
                    if (!current) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
                    const response = await homes.artifacts(serverId).handle(`/v1/artifacts/${artifactId}`, { method: 'POST', body: JSON.stringify({
                        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(next)), expectedHeaderVersion: current.headerVersion,
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(next) }), expectedBodyVersion: current.bodyVersion,
                    }) });
                    return response?.ok ? { ok: true } : { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
                },
            }));
            const payload = request.payload;
            if (!payload || typeof payload !== 'object' || !('artifactId' in payload) || typeof payload.artifactId !== 'string') {
                throw new Error('Invalid approved replay transport');
            }
            return replay.replayApprovedApprovalRequest({ artifactId: payload.artifactId });
        } finally { account.dispose(); }
    });
    const executor = createDefaultActionExecutor();
    const requested = { sessionId, kind: skillRevision ? 'skill' : 'mcp_server', id: itemId, state: 'on', reason: 'Read the project issues' };
    const proposal = await executor.execute('session.capabilities.set', requested, { serverId, surface: 'agent', authority: 'account_automation',
        actionCaller: { kind: 'host' }, defaultSessionId: sessionId, actionRequestId: `enable-linear-${choice}`,
        defaultSessionMachineId: 'machine', serverIdentityId: 'srv_capability-home-identity' });
    expect(proposal).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(row.metadataVersion).toBe(1);
    const artifact = homes.artifacts(serverId).list().find(row => row.id !== itemId);
    if (!artifact) throw new Error('Existing approval machinery did not persist the request');
    const artifactId = artifact.id;
    const approval = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
    expect(approval.actionArgs).toEqual(requested);
    if (tray) homes.answer(serverId, `POST /v1/artifacts/${artifact.id}`, { select: async input => {
        const response = await homes.artifacts(serverId).handle(`/v1/artifacts/${artifact.id}`, { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Missing Artifact persistence boundary');
        const stored = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
        // The server has committed settlement. Hold its HTTP acknowledgement while the
        // open-only tray observes that settlement and unmounts the actual card.
        if (stored.status === 'executed') { replaySettled.resolve(); await returnReplay.promise; }
        return { status: response.status, body: await response.json() };
    } });
    const context = { machineId: 'machine', machinePlatform: 'posix', projectKey: 'happier', directory: '/repo', agentId: 'gemini' } as const;
    const rules = readRules();
    const decision = resolveReachV1(rules, context);
    expect(decision).toMatchObject({ enabled: false, decidedBy: { ruleId: 'except-gemini', agentQualified: true } });
    let pendingDecision: Promise<void> | undefined;
    const mount = async (current: ApprovalRequest) => {
        let latest!: ReturnType<typeof useCapabilityEnableApproval>;
        function Card() {
            latest = useCapabilityEnableApproval({ artifact: { id: artifactId,
        header: { kind: 'approval_request.v1', title: null, serverId } }, approval: current, sessionId, decidedBy: decision.decidedBy,
        projectKey: 'happier', machineId: 'machine', itemTitle: 'Linear', agentName: 'Gemini',
        names: { agentName: () => 'Gemini', agentNames: ids => ids.map(() => 'Gemini'), projectName: key => key, machineName: () => 'MacBook', folderLabel: () => '~/repo' } });
            return React.createElement(CapabilityEnableApprovalView, { chrome: 'card', decisionsAvailable: latest.ready,
                onChoose: choice => { pendingDecision = latest.choose?.(choice); }, model: { title: latest.title ?? '', reason: latest.reason, offLine: null, alwaysLine: null,
                    cost: null, timing: null, connected: false, allowLabel: 'Allow for this session', alwaysLabel: latest.alwaysLabel,
                    blocking: null, decisionError: null, deciding: latest.state?.status === 'deciding',
                    settled: describeCapabilityEnableSettled({ approvalStatus: current.status, snapshot: latest.state, itemTitle: 'Linear',
                        agentName: 'Gemini', placeName: 'happier', timing: null, undoAlways: () => latest.undoAlways?.(),
                        undoSession: latest.undoSession, retryAlways: () => latest.retryAlways?.() }) } });
        }
        const screen = await renderScreen(React.createElement(Card));
        return { getCurrent: () => latest, text: screen.getTextContent, unmount: async () => { await act(async () => screen.tree.unmount()); },
            chooseAlways: () => screen.pressByTestId('capability-enable-always') };
    };
    let hook = await mount(approval);
    await vi.waitFor(() => {
        expect(hook.getCurrent().alwaysWrite).not.toBeNull();
        expect(hook.getCurrent().rulesStatus).toBe('ready');
        expect(hook.getCurrent().ready).toBe(true);
    });
    expect(hook.getCurrent().alwaysLabel).toBe('Always for Gemini in happier');
    expect(hook.getCurrent().reason).toBe(requested.reason);
    expect(hook.getCurrent().state?.status).toBe('idle');
    if (skillRevision) {
        // Another device commits without a local wake, after the tray has retained its controller.
        skillRecord = { key: 'skill-rules', value: { v: 1, rules: [...skillRecord.value.rules,
            { id: 'other-machine', skillId: itemId, target: { t: 'machine', machineId: 'other' }, enabled: true, createdAt: 2, updatedAt: 2 }] } };
        revision = 2;
    }
    if (tray) {
        let pending: Promise<void> | undefined;
        let ended = false;
        await act(async () => {
            hook.chooseAlways();
            pending = pendingDecision;
            expect(pending).toBeDefined();
            await Promise.race([replaySettled.promise, pending?.then(() => { ended = true; })]);
        });
        expect({ ended, status: hook.getCurrent().state?.status, paths: homes.requests.map(({ path }) => path) })
            .toMatchObject({ ended: false, status: 'deciding' });
        await hook.unmount();
        if (choice === 'tray_account_changed') await homes.switchAccount(serverId, 'other-account');
        await act(async () => { returnReplay.resolve(); await pending; });
    } else await act(async () => { await hook.getCurrent().choose?.(choice === 'reject' ? 'reject' : 'always'); });
    if (choice === 'reject' || choice === 'cannot_resume') {
        expect(hook.getCurrent().state?.status).toBe(choice === 'reject' ? 'rejected' : 'decision_failed');
        expect(revision).toBe(1); expect(row.metadataVersion).toBe(1);
        await hook.unmount();
        hook = await mount(approval);
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        // No save, retry or inverse remains: retired view-local outcomes do not own a controller.
        expect(hook.getCurrent().state?.status).toBe('idle');
    } else {
        const settled = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
        if (choice === 'tray_account_changed') {
            // The approval owner refuses the retired Account's result before a rules
            // Action can start. A durable settlement must not authorize the new Account.
            expect(revision).toBe(1);
            await homes.switchAccount(serverId, accountId);
            hook = await mount(settled);
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().state).toMatchObject({ status: 'idle', approved: false });
            return;
        }
        if (choice === 'tray_failed') {
            expect(revision).toBe(1);
            hook = await mount(settled);
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().state).toMatchObject({ status: 'always_failed', approved: true });
            expect(hook.getCurrent().state?.errorCode).toBe('conflict');
            expect(hook.text()).toContain('capabilities.session.ask.alwaysFailed');
            refuseRules = false;
            await act(async () => { await hook.getCurrent().retryAlways?.(); });
            expect(row.metadataVersion).toBe(2);
        } else if (tray) {
            // The open-only attention card leaves as soon as the durable approval settles,
            // before its replay returns and the controller can start the rules Action.
            expect(resolveReachV1(readRules(), context).enabled).toBe(true);
            if (skillRevision) {
                expect(attempts).toEqual([2]);
                expect(readRules().find(rule => rule.id === 'other-machine')?.enabled).toBe(true);
                expect(readRules().find(rule => rule.id === 'except-gemini')).toMatchObject({ agentId: 'gemini', enabled: true });
            }
        } else expect(hook.getCurrent().state).toMatchObject({ status: 'always_saved', approved: true });
        const result = settled.execution?.ok ? SessionCapabilitiesSetOutputV1Schema.parse(settled.execution.result) : null;
        expect(result).toMatchObject({ ok: true, previous: 'inherit', applyTiming: { t: 'next_turn' } });
        if (!result?.ok) throw new Error('Expected successful capability execution');
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected Plain Session owner metadata');
        const appliedMetadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v });
        expect(appliedMetadata)
            .toMatchObject(skillRevision ? { skillSelectionV1: { forceIncludeSkillIds: [itemId] } }
                : { mcpSelectionV1: { forceIncludeServerIds: [itemId] } });
        const change = readSessionCapabilityApplyChange(appliedMetadata, () => 'Linear');
        expect(sessionCapabilityApplyNotice({ change, pendingApply: readPendingCapabilityApplyV1(appliedMetadata),
            applyTiming: { mcp: result.applyTiming, skills: { t: 'next_turn' } },
            machineOnline: true, machineName: 'MacBook', turnSettled: true })?.key).toBe('joinsNextTurn');
        expect(resolveReachV1(readRules(), context).enabled).toBe(true);
        expect(readRules().find(rule => rule.id === 'general')?.enabled).toBe(true);
        if (choice === 'remount') await hook.unmount();
        if (choice === 'remount' || choice === 'tray' || skillRevision) {
            hook = await mount(settled);
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().state).toMatchObject({ status: 'always_saved', approved: true });
        }
        await act(async () => { expect(await hook.getCurrent().undoAlways?.()).toEqual({ ok: true }); });
        expect(resolveReachV1(readRules(), context).enabled).toBe(false);
        if (!tray && choice !== 'remount') { await hook.unmount(); hook = await mount(settled); }
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        await act(async () => { expect(await hook.getCurrent().undoSession()).toMatchObject({ ok: true, result: { ok: true, state: 'inherit' } }); });
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected Plain Session owner metadata after Undo');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v }))
            .toMatchObject(skillRevision ? { skillSelectionV1: { forceIncludeSkillIds: [] } }
                : { mcpSelectionV1: { forceIncludeServerIds: [] } });
    }
});

it('restores the acknowledged previous skill rules, retaining Always on a refused or unacknowledged Undo', async () => {
    const accountId = 'skill-undo-owner';
    const serverId = await homes.addHome({ name: 'Skill Undo Home', serverUrl: 'https://skill-undo.test', accountId });
    const account = await captureLazyActionAccountContext(serverId);
    let skillId: string;
    try {
        const artifact = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'QA skill', bundleSchemaId: 'skills.skill_md_v1' },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: qa-skill\n---\nUse it.').toString('base64') }] }) });
        skillId = artifact.artifactId;
    } finally { account.dispose(); }
    const previous = [{ id: 'everywhere-off', target: { t: 'allMachines' as const }, enabled: false, createdAt: 1, updatedAt: 1 }];
    let record: PromptLibraryRecordV1 = { key: 'skill-rules', value: { v: 1, rules: previous.map(rule => ({ ...rule, skillId })) } };
    let revision = 1;
    let undoRefused = true;
    const undoAck = createDeferred<void>();
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
        { key: record.key, revision, content: { t: 'plain', v: record } },
        ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== record.key).map(key => ({ key, revision: 1, content: null })),
    ] } }) });
    homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, { select: input => {
        const mutation = PromptLibraryRowMutationV1Schema.parse(input);
        if (mutation.expectedRevision !== revision || revision === 2 && undoRefused) return { body: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain rules');
        record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
        return { body: { status: 'updated', revision: ++revision, cursor: revision }, ...(revision === 3 ? { respondAfter: undoAck.promise } : {}) };
    } });
    const execute = createDefaultActionExecutor();
    const rules = createReachRulesController({ key: 'skill-undo', kind: 'skill', itemId: skillId, rules: previous,
        revision, status: 'ready', valueAvailable: true }, async (actionId, input) => {
        const result = await execute.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId, expectedAccountId: accountId });
        if (result.ok) expect(SkillsRulesSetOutputV1Schema.safeParse(result.result).success).toBe(true);
        return result;
    });
    const controller = createCapabilityEnableApprovalController({ alwaysWrite: { place: { t: 'machine', machineId: 'machine' }, state: 'on' },
        decide: async () => true, changeRules: rules.change, undoRules: rules.undoLast });
    await controller.choose('always');
    expect(controller.getSnapshot()).toMatchObject({ status: 'always_saved', errorCode: null });
    expect(await controller.undoAlways()).toEqual({ ok: false, message: 'conflict' });
    expect(controller.getSnapshot().status).toBe('always_saved');
    undoRefused = false;
    const undo = controller.undoAlways();
    await vi.waitFor(() => expect(revision).toBe(3));
    expect(controller.getSnapshot().status).toBe('always_saved');
    undoAck.resolve();
    expect(await undo).toEqual({ ok: true });
    expect(controller.getSnapshot().status).toBe('session_allowed');
    if (record.key !== 'skill-rules') throw new Error('Expected skill rules');
    expect(reachRulesToDraftsV1(record.value.rules)).toEqual(reachRulesToDraftsV1(previous));
});
