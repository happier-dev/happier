import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionFixture, makeToolCall, renderScreen, renderHook, standardCleanup,
    renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { APPROVAL_ARTIFACT_KINDS_V1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { listTranscriptApprovalArtifactsForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '@/components/tools/shell/approvals/transcriptSettledApprovalPresentations';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { writeCapabilitySelectionApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readApprovedSavedSkillResult } from './savedSkillResultModel';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionMetadataOwnerPatchV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { t } from '@/text';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { buildSessionCapabilitiesModel } from '@/components/sessions/capabilities/sessionCapabilitiesModel';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// Native image creation is outside Node; mount the real web drawing adapter beneath the real face.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const machineTransport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// Only Machine RPC is substituted; effective inclusion is resolved by the real Protocol owner.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));
await loadSyncSingletonForTests();
const { SavedSkillResult } = await import('./SavedSkillResult');
const { TranscriptToolResultCard } = await import('@/components/sessions/transcript/references/TranscriptToolResultCard');
const { ApprovalPromptCard } = await import('@/components/tools/shell/approvals/ApprovalPromptCard');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useSessionCapabilities, useSessionSkillCount } = await import('@/sync/domains/capabilities/session/useSessionCapabilities');
let serverId: string;
beforeEach(async () => {
    await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); navigation.push.mockClear(); machineTransport.mockReset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Skill Home', serverUrl: 'https://saved-skills.test', accountId: 'owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://saved-skills.test', { serverId });
    if (!credentials) throw new Error('Missing test credentials');
    await restoreConnectionToActiveServer(credentials);
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('retains the approved create at its transcript call and renders the same saved card from the observed execution', async () => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    getStorage().setState({ sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    const request = ApprovalRequestV1Schema.parse(projectApprovalRequestForPublicRead(ApprovalRequestV1Schema.parse({
        v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
        createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', actionId: 'skills.create',
        actionArgs: { name: 'Review', files: [] }, summary: 'Create a skill',
        origin: { kind: 'transcript_tool_call', sessionId, toolCallId: 'create-call' },
        decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {
            ok: true, skillId: 'review', revision: '1:1', includedInSessionId: null, incomplete: 'session_include',
            summary: { name: 'Review', description: 'Review changes' },
            inclusion: { ok: false, code: 'applies_to_new_sessions_only' },
        } },
    })));
    const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId });
    const artifact = { ...createUsageNoticeArtifactFixture({ id: 'create-approval' }),
        sourceServerId: serverId, ownerAccountId: 'owner', header, rawHeader: header,
        kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, body: JSON.stringify(request), sessions: [sessionId] };
    const selected = listTranscriptApprovalArtifactsForSession([artifact], { serverId, sessionId }, {
        settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
    });
    expect(selected).toHaveLength(1);
    const screen = await renderWithSessionTranscriptSource(<ApprovalPromptCard artifact={artifact} approval={request} sessionId={sessionId} />,
        createTestSessionTranscriptSource({ serverId, sessionId }));
    expect(screen.findByTestId('saved-skill-result')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Review changes');
    expect(screen.getTextContent()).toContain('Not attached');
    expect(screen.findByTestId('saved-skill-view')).not.toBeNull();
    expect(screen.findByTestId('saved-skill-attach')).not.toBeNull();
    expect(screen.findByTestId('approval-prompt-card')).toBeNull();
    expect(homes.requests.filter(request => request.path.includes('/skills') || request.path.includes('/artifacts'))).toHaveLength(0);
});

it('renders a saved result without skill reads and keeps its commit count at zero for unrelated MCP and Artifact arrivals', async () => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    const metadata = writeSessionCapabilitySelectionToMetadataV1({ path: '/repo', host: 'test', machineId: 'machine', name: 'Researcher', bot: { kind: 'bot' as const } },
        setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on'), { sessionActive: true });
    const session = createSessionFixture({ id: sessionId, serverId, active: true, metadata });
    const makerRow = createSessionListRenderableSessionFixture({ id: sessionId, metadata });
    getStorage().setState({ sessions: { [sessionId]: session }, sessionListRowsByServerId: { [serverId]: { [sessionId]: makerRow } },
        sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    const binding = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    await vi.waitFor(() => expect(binding.getCurrent().binding).not.toBeNull());
    let commits = 0;
    const fact = { ok: true, skillId: 'review', revision: '1:1', includedInSessionId: sessionId,
        summary: { name: 'Review', description: null, creator: { kind: 'agent', accountId: 'owner', sessionId } } };
    const tool = makeToolCall({ name: 'mcp__happier__skills_create', state: 'completed', input: { name: 'Review', files: [] }, result: fact });
    const screen = await renderScreen(<React.Profiler id="saved" onRender={() => { commits++; }}>
        <TranscriptToolResultCard tool={tool} serverId={serverId} sessionId={sessionId} mediaPreviewEnabled={false} />
    </React.Profiler>);
    expect(screen.getTextContent()).toContain('Review');
    expect(screen.getTextContent()).toContain('Researcher');
    expect(screen.findByTestId('saved-skill-result')).not.toBeNull();
    expect(screen.findByTestId('saved-skill-view')?.props.disabled).toBe(false);
    expect(homes.requests.filter(request => request.path.includes('/skills') || request.path.includes('/artifacts'))).toHaveLength(0);
    commits = 0;
    await act(async () => getStorage().setState(current => ({ sessions: { ...current.sessions, [sessionId]: {
        ...current.sessions[sessionId]!, metadata: writeSessionCapabilitySelectionToMetadataV1(metadata,
            setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on'), { sessionActive: true }),
    } }, sessionListRowsByServerId: { ...current.sessionListRowsByServerId, [serverId]: {
        ...current.sessionListRowsByServerId[serverId], [sessionId]: { ...makerRow,
            metadata: writeSessionCapabilitySelectionToMetadataV1(metadata,
                setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on'), { sessionActive: true }),
        },
    } } })));
    expect(commits).toBe(0);
    await act(async () => getStorage().setState(current => ({ artifacts: { ...current.artifacts,
        unrelated: createUsageNoticeArtifactFixture({ id: 'unrelated' }),
    } })));
    expect(commits).toBe(0);
});

it.each([
    ['next_turn', undefined, 'loadsAfterTurn', 'loadsAfterTurnDetail'],
    ['restart_to_apply', 'user', 'needsRestart', 'restartDetail'],
    ['restart_to_apply', 'terminal', 'needsRestart', 'restartTerminalDetail'],
] as const)('uses pushed %s/%s state for an approved saved result and keeps restart tied to turn settlement', async (reason, restartBy, word, detail) => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    const metadata = writeCapabilitySelectionApplyV1(writeSessionCapabilitySelectionToMetadataV1({ path: '/repo', host: 'test', machineId: 'machine',
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'unsupported' } } },
        setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on'), { sessionActive: true }), {
        skills: { reason, ...(restartBy ? { restartBy } : {}) },
    });
    const session = createSessionFixture({ id: sessionId, serverId, active: true, activeAt: Date.now(), metadata });
    const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
    getStorage().setState({ sessions: { [sessionId]: session }, sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    getStorage().getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: scope.accountId });
    const approval = ApprovalRequestV1Schema.parse(projectApprovalRequestForPublicRead(ApprovalRequestV1Schema.parse({
        v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'agent', sessionId },
        requestedSurface: 'agent', actionId: 'skills.create', actionArgs: {}, summary: 'Create skill',
        origin: { kind: 'transcript_tool_call', sessionId, toolCallId: 'create-call' }, decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, result: { ok: true, skillId: 'review', revision: '1:1', includedInSessionId: sessionId } },
    })));
    const fact = readApprovedSavedSkillResult(approval);
    if (!fact) throw new Error('Missing approved save acknowledgment');
    const screen = await renderScreen(<SavedSkillResult fact={fact} serverId={serverId} sessionId={sessionId} />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t(`capabilities.skills.saved.${word}`)));
    expect(screen.getTextContent()).toContain(t(`capabilities.skills.saved.${detail}`));
    expect(screen.findByTestId('saved-skill-view')?.props.disabled).toBe(false);
    expect(screen.findByTestId('saved-skill-attach')).toBeNull();
    if (restartBy === 'user') {
        expect(screen.findByTestId('saved-skill-restart')?.props.disabled).toBe(false);
        await act(async () => getStorage().setState({ sessions: { [sessionId]: { ...session, thinking: true, thinkingAt: Date.now() } } }));
        expect(screen.findByTestId('saved-skill-restart')?.props.disabled).toBe(true);
    } else expect(screen.findByTestId('saved-skill-restart')).toBeNull();
    expect(homes.requests.filter(request => request.path.includes('/skills') || request.path.includes('/artifacts'))).toHaveLength(0);
});

it.each([false, true])('keeps Info, pane and card aligned through external selection pushes without refetch (rule on: %s)', async ruleOn => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    let selection = setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on');
    const metadata = () => writeSessionCapabilitySelectionToMetadataV1({ path: '/repo', host: 'test', machineId: 'machine', flavor: 'codex' },
        selection, { sessionActive: false });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`,
        { select: () => ({ body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata: metadata() }) } }) });
    machineTransport.mockImplementation(async () => {
        const resolved = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
            selection, agentAcceptsUserMcp: true, mcp: null, skills: { items: [{ skillId: 'review', name: 'Review' }],
                rules: ruleOn ? [{ id: 'everywhere', skillId: 'review', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] : [] } });
        return { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
            skills: { items: resolved.skills.items, plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } };
    });
    const push = () => getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, metadata: metadata() }) },
        sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    push();
    const pane = await renderHook(() => useSessionCapabilities(sessionId, undefined, { serverId }));
    await act(async () => pane.getCurrent().demandPreview());
    await vi.waitFor(() => expect(pane.getCurrent().preview?.skills.items[0]?.selected).toBe(true));
    const info = await renderHook(() => useSessionSkillCount(sessionId, serverId));
    const paneCount = () => buildSessionCapabilitiesModel({ view: pane.getCurrent().preview, state: 'ready',
        selection: pane.getCurrent().selection, rules: () => null, skillStatus: () => [], mcpStatus: () => [],
        names: { machineName: () => '', projectName: () => '', agentName: () => '', agentNames: () => [], folderLabel: () => '' }, readOnly: false }).counts.skills;
    expect(info.getCurrent()).toBe(1);
    expect(paneCount()).toBe(1);
    let commits = 0;
    const readsBeforeCard = machineTransport.mock.calls.length;
    const screen = await renderScreen(<React.Profiler id="inherited-save" onRender={() => { commits++; }}>
        <SavedSkillResult serverId={serverId} sessionId={sessionId}
            fact={{ ok: true, skillId: 'review', revision: '1:1', includedInSessionId: ruleOn ? null : sessionId,
                ...(ruleOn ? { incomplete: 'session_include' } : {}) }} />
    </React.Profiler>);
    expect(machineTransport.mock.calls.length).toBe(readsBeforeCard);
    expect(screen.findByTestId('saved-skill-attach')).toBeNull();
    // An agent/another client pushes Off, then resets to inherit. No local write or refresh occurs.
    selection = setSessionCapabilitySelectionItemV1(selection, 'skill', 'review', 'off');
    await act(async () => push());
    expect(paneCount()).toBe(0);
    expect(screen.findByTestId('saved-skill-attach')).not.toBeNull();
    expect(info.getCurrent()).toBe(0);
    selection = setSessionCapabilitySelectionItemV1(selection, 'skill', 'review', 'inherit');
    await act(async () => push());
    expect(paneCount()).toBe(ruleOn ? 1 : 0);
    expect(info.getCurrent()).toBe(ruleOn ? 1 : 0);
    expect(Boolean(screen.findByTestId('saved-skill-attach'))).toBe(!ruleOn);
    expect(screen.getTextContent().includes(t('capabilities.skills.saved.notAttached'))).toBe(!ruleOn);
    // Attach again changes the override; the pane/card overlay must agree even while the prior preview is retained.
    selection = setSessionCapabilitySelectionItemV1(selection, 'skill', 'review', 'on');
    await act(async () => push());
    expect(screen.findByTestId('saved-skill-attach')).toBeNull();
    expect(info.getCurrent()).toBe(1);
    expect(paneCount()).toBe(1);
    selection = setSessionCapabilitySelectionItemV1(selection, 'skill', 'review', 'off');
    await act(async () => push());
    expect(screen.findByTestId('saved-skill-attach')).not.toBeNull();
    expect(info.getCurrent()).toBe(0);
    expect(paneCount()).toBe(0);
    expect(machineTransport.mock.calls.length).toBe(readsBeforeCard);
    commits = 0;
    await act(async () => push());
    expect(commits).toBe(0);
});

it('keeps an inclusion acknowledgment saved while pushed selection is absent, and exposes retry after an explicit refusal', async () => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId,
        metadata: { path: '/repo', host: 'test' } }) }, sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    const included = await renderScreen(<SavedSkillResult serverId={serverId} sessionId={sessionId} fact={{ ok: true,
        skillId: 'review', revision: '1:1', includedInSessionId: sessionId }} />);
    expect(included.getTextContent()).toContain('Saved');
    expect(included.getTextContent()).not.toContain('Not attached');
    expect(included.findByTestId('saved-skill-attach')).toBeNull();
    await included.unmount();
    const partial = await renderScreen(<SavedSkillResult serverId={serverId} sessionId={sessionId} fact={{ ok: true,
        skillId: 'review', revision: '1:1', includedInSessionId: null, incomplete: 'session_include' }} />);
    expect(partial.getTextContent()).toContain('Not attached');
    expect(partial.getTextContent()).not.toContain('This Session');
    expect(partial.findByTestId('saved-skill-attach')).not.toBeNull();
    expect(partial.findByTestId('saved-skill-view')).not.toBeNull();
    await partial.unmount();
    const elsewhere = await renderScreen(<SavedSkillResult serverId={serverId} sessionId={sessionId} fact={{ ok: true,
        skillId: 'review', revision: '1:1', includedInSessionId: null }} />);
    expect(elsewhere.getTextContent()).not.toContain('This Session');
    expect(elsewhere.getTextContent()).toContain('Saved');
    expect(elsewhere.getTextContent()).not.toContain('Not attached');
    expect(elsewhere.findByTestId('saved-skill-attach')).toBeNull();
});

it('keeps the saved identity and a localized new-Session refusal without Machine or desired-selection facts', async () => {
    const scope = { serverId, accountId: 'owner' };
    getStorage().setState({ sessions: {}, sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    const screen = await renderScreen(<SavedSkillResult serverId={serverId} sessionId="c123456789012345678901234" fact={{ ok: true,
        skillId: 'review', revision: '1:1', includedInSessionId: null, incomplete: 'session_include',
        inclusion: { ok: false, code: 'applies_to_new_sessions_only' }, summary: { name: 'Review', description: null } }} />);
    expect(screen.getTextContent()).toContain(t('capabilities.session.apply.newSessionsOnly', { item: 'Review', machine: '' }));
    expect(screen.getTextContent()).toContain('Review');
    expect(screen.findByTestId('saved-skill-view')).not.toBeNull();
    expect(screen.findByTestId('saved-skill-attach')).not.toBeNull();
});

it('keeps View unavailable for a saved skill from another Home', async () => {
    const scope = { serverId, accountId: 'owner' };
    getStorage().setState({ sessionLocalStateScope: scope, profileScope: scope,
        settingsScope: { serverId: 'another-home', accountId: 'another-account' } });
    const binding = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    await vi.waitFor(() => expect(binding.getCurrent().binding?.scope).toEqual(scope));
    const screen = await renderScreen(<SavedSkillResult serverId={serverId} fact={{ ok: true,
        skillId: 'review', revision: '1:1', includedInSessionId: null, summary: { name: 'Review', description: null } }} />);
    expect(screen.findByTestId('saved-skill-view')?.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('common.unavailable'));
});

it('opens the acknowledged skill and attaches it again through the mounted Action and real metadata writer', async () => {
    const sessionId = 'c123456789012345678901234';
    const scope = { serverId, accountId: 'owner' };
    const metadata = { path: '/repo', host: 'test', machineId: 'machine', flavor: 'claude' };
    let row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`,
        { select: () => ({ body: { session: row } }) });
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
            metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { body: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: null })) } });
    const account = await captureLazyActionAccountContext(serverId);
    let skillId: string;
    try {
        const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: review\n---\nReview changes').toString('base64') }] }) });
        skillId = created.artifactId;
    } finally { account.dispose(); }
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, metadata }) },
        sessionLocalStateScope: scope, settingsScope: scope, profileScope: scope });
    const screen = await renderScreen(<SavedSkillResult fact={{ ok: true, skillId, revision: '1:1', incomplete: 'session_include' }}
        serverId={serverId} sessionId={sessionId} />);
    await vi.waitFor(() => expect(screen.findByTestId('saved-skill-attach')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('saved-skill-view'));
    expect(navigation.push).toHaveBeenCalledWith(`/settings/skills/${skillId}`);
    await screen.pressByTestIdAsync('saved-skill-attach');
    await vi.waitFor(() => {
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected a plain owner metadata write');
        const updated = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v });
        expect(readSessionCapabilitySelectionFromMetadataV1(updated).skills.forceIncludeSkillIds).toContain(skillId);
    });
    expect(screen.findByTestId('saved-skill-error')).toBeNull();
});
