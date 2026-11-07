import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { renderHook, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1,
    SessionMetadataOwnerPatchV1Schema, SessionMetadataVersionConflictV1Schema,
    SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillComposerGroups, pickSkillComposerRow } from '@/sync/domains/skills/skillComposerGroups';
import { readSessionCapabilitySelectionFromMetadataV1, resolveSelectionRestartMarkersForStartupV1, writeCapabilitySelectionApplyV1, clearCapabilitySelectionApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { SpawnCapabilitiesPreviewInputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { sessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// Only the remote Machine RPC transport is substituted; P2 preview/selection and UI models are real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
await loadSyncSingletonForTests();
const { useNewSessionCapabilitiesPopover, useExistingSessionCapabilitiesPopover } = await import('./useSessionCapabilitiesPopover');
const { getStorage } = await import('@/sync/domains/state/storageStore');

const presentation = { rules: () => [], mcpStatus: () => [], skillStatus: () => [],
    names: { agentName: () => 'Codex', agentNames: (ids: readonly string[]) => ids.map(() => 'Codex'), machineName: () => 'MacBook', projectName: (key: string) => key, folderLabel: () => '~/repo' },
    nativeSkills: { items: [{ name: 'native-review', path: '/skills/review' }], canDisable: true, machineName: 'MacBook', agentName: 'Codex',
        applyTiming: { t: 'next_turn' as const } }, machineOnline: true, machineName: 'MacBook', turnSettled: true };
const preview = { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } };
let serverId: string;
beforeEach(async () => {
    await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Session Home', serverUrl: 'https://popover-capabilities.test', accountId: 'owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    transport.mockReset(); transport.mockResolvedValue(preview);
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('keeps an aggregate pending notice on its selected kind when only the other kind has a runtime refusal', async () => {
    const selection = setSessionCapabilitySelectionItemV1(setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on'), 'skill', 'review', 'on');
    const metadata = writeCapabilitySelectionApplyV1(writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true }),
        { skills: { reason: 'missing_resume_snapshot' } });
    const { useSessionCapabilities } = await import('@/sync/domains/capabilities/session/useSessionCapabilities');
    const hook = await renderHook(() => useSessionCapabilities('c123456789012345678901234', metadata, { serverId }));
    expect(sessionCapabilityApplyNotice({ pendingApply: hook.getCurrent().pendingApply,
        applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } }, change: null,
        machineOnline: true, machineName: 'QA', turnSettled: true })?.key).toBe('pendingNextTurn');
});

it('edits only the authoring draft and does not request a Machine preview before demand', async () => {
    const hook = await renderHook(() => {
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({
            mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['linear'], forceExcludeServerIds: [] } });
        return useNewSessionCapabilitiesPopover({ machineId: 'machine', directory: '/repo', agentId: 'codex', enabled: true,
            selection, setSelection }, { ...presentation, machineOnline: null });
    });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => hook.getCurrent().setItem('native_skill', 'native-review', 'off'));
    expect(hook.getCurrent().model.groups[0]?.nativeRow?.rows[0]).toMatchObject({ dimmed: true, action: { kind: 'turn_on' } });
    expect(homes.requests.some(request => request.input !== null && request.path.includes('/sessions/'))).toBe(false);
    await act(async () => hook.getCurrent().demandPreview());
    await vi.waitFor(() => expect(hook.getCurrent().model.state, hook.getCurrent().error ?? '').toBe('ready'));
});

it('reads a draft check that failed against a machine REACH says is away as offline, not as a failure', async () => {
    transport.mockRejectedValue(new Error('rpc timed out'));
    const hook = await renderHook<ReturnType<typeof useNewSessionCapabilitiesPopover>, boolean | null>((machineOnline) => {
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
        return useNewSessionCapabilitiesPopover({ machineId: 'machine', directory: '/repo', agentId: 'codex', enabled: true,
            selection, setSelection }, { ...presentation, machineOnline });
    }, { initialProps: false });
    await act(async () => hook.getCurrent().demandPreview());
    await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('machine_unreachable'));
    await hook.rerender(null);
    expect(hook.getCurrent().model.state).toBe('error');
    await hook.rerender(true);
    expect(hook.getCurrent().model.state).toBe('error');
    expect(transport).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps draft Turn on selected with rules enabled=%s without making a Session write', async ruleOn => {
    const rules = [{ id: 'fixture-rule', target: { t: 'allMachines' as const }, enabled: ruleOn, createdAt: 1, updatedAt: 1 }];
    transport.mockImplementation(async request => {
        const input = SpawnCapabilitiesPreviewInputV1Schema.parse(Reflect.get(request as object, 'payload'));
        const resolved = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' },
            selection: input.capabilitySelection ?? {}, agentAcceptsUserMcp: true, skills: null,
            mcp: { v: 1, strictMode: false, servers: [{ id: 'fixture', name: 'fixture', transport: 'http', remote: { url: 'https://fixture.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
                bindings: rules.map(rule => ({ ...rule, serverId: 'fixture' })) } });
        return { ...preview, mcp: { ...preview.mcp, items: resolved.mcp.items.map(({ effectiveConfig: _config, ...item }) => item) } };
    });
    const hook = await renderHook(() => {
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>(setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'fixture', 'off'));
        return useNewSessionCapabilitiesPopover({ machineId: 'machine', directory: '/repo', agentId: 'codex', enabled: true, selection, setSelection },
            { ...presentation, rules: () => rules });
    });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => hook.getCurrent().demandPreview());
    await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('ready'));
    const row = hook.getCurrent().model.groups[1]!.rows[0]!;
    expect(row.action).toEqual({ kind: 'turn_on', state: ruleOn ? 'inherit' : 'on' });
    const action = row.action;
    if (action.kind !== 'turn_on') throw new Error('Expected Turn on');
    await act(async () => hook.getCurrent().setItem('mcp_server', row.id, action.state));
    await vi.waitFor(() => expect(hook.getCurrent().model.groups[1]?.rows[0]).toMatchObject({ id: 'fixture', dimmed: false, action: { kind: 'remove' } }));
    expect(hook.getCurrent().modelInput.selection.mcp?.forceIncludeServerIds).toEqual(ruleOn ? [] : ['fixture']);
    expect(homes.requests.some(request => request.input !== null && request.path.includes('/sessions/'))).toBe(false);
});

it('reuses the Session Action owner for rollback, previous-override Undo and read-only viewers', async () => {
    const sessionId = 'c123456789012345678901234';
    const initial = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'codex', startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } },
        skillSelectionV1: { v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native-review'] } } });
    if (!initial.ok) throw new Error('Invalid owner fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(initial.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    const metadata = () => row.ownerMetadata?.t === 'plain' ? MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v })) : null;
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, active: true, metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView: metadata() }) }, sessionLocalStateScope: { serverId, accountId: 'owner' } });
    let conflict = false;
    let acknowledgeApply = false;
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { select: () => {
        const response = { body: { session: SessionCurrentProjectionRecordV1Schema.parse(row) } };
        if (conflict) {
            conflict = false;
            const edited = createSessionOwnerMetadataV1({ metadata: writeSessionCapabilitySelectionToMetadataV1(metadata() ?? {},
                setSessionCapabilitySelectionItemV1(readSessionCapabilitySelectionFromMetadataV1(metadata()), 'native_skill', 'native-review', 'on'), { sessionActive: true }) });
            if (!edited.ok) throw new Error('Invalid concurrent selection');
            row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, metadataVersion: row.metadataVersion + 1, displayProjectionV1: undefined,
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(edited.ownerMetadata) });
        }
        if (acknowledgeApply) {
            acknowledgeApply = false;
            const acknowledged = createSessionOwnerMetadataV1({ metadata: {
                ...resolveSelectionRestartMarkersForStartupV1({ current: metadata() ?? {}, applied: readSessionCapabilitySelectionFromMetadataV1(metadata()) }),
                hostPid: 42,
            } });
            if (!acknowledged.ok) throw new Error('Invalid runtime acknowledgment');
            row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, metadataVersion: row.metadataVersion + 1, displayProjectionV1: undefined,
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(acknowledged.ownerMetadata) });
        }
        return response;
    } });
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        if (patch.sharedMetadata.expectedVersion !== row.metadataVersion || patch.agentState.expectedVersion !== row.agentStateVersion) {
            return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
        }
        row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + Number(patch.agentState.ciphertext !== row.agentState),
            ...('displayProjectionV1' in patch ? { displayProjectionV1: patch.displayProjectionV1 ?? undefined } : {}) });
        return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
    } });
    const target = { kind: 'session' as const, sessionId, serverId, readOnly: false };
    homes.answer(serverId, 'GET /v1/artifacts', { body: [] });
    const hook = await renderHook<ReturnType<typeof useExistingSessionCapabilitiesPopover>, { readOnly: boolean; machineOnline: boolean | null }>(
        ({ readOnly, machineOnline }) => useExistingSessionCapabilitiesPopover({ ...target, readOnly }, { ...presentation, machineOnline }),
        { initialProps: { readOnly: false, machineOnline: null } });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => { expect(await hook.getCurrent().setItem('native_skill', 'native-review', 'on')).toMatchObject({ ok: true, state: 'on', previous: 'off' }); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual([]);
    // The receipt for the in-place Undo line names the change in the person's words (turning a native skill on is an add).
    expect(hook.getCurrent().undoReceipt).toEqual({ kind: 'native_skill', title: 'native-review', change: 'added' });
    await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-review']);
    // Undo resent the previous override and settled the line; it is not offered twice.
    expect(hook.getCurrent().undoReceipt).toBeNull();
    await act(async () => { await hook.getCurrent().setItem('native_skill', 'native-review', 'on'); });
    expect(hook.getCurrent().undoReceipt).not.toBeNull();
    // The newest change owns the offer, and it resends that change's own previous override.
    await act(async () => { await hook.getCurrent().setItem('native_skill', 'native-review', 'off'); });
    expect(hook.getCurrent().undoReceipt).toEqual({ kind: 'native_skill', title: 'native-review', change: 'removed' });
    await act(async () => { await hook.getCurrent().undoLast(); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual([]);
    await act(async () => { await hook.getCurrent().setItem('native_skill', 'native-review', 'off'); });
    conflict = true;
    await act(async () => { expect(await hook.getCurrent().setItem('native_skill', 'native-review', 'on')).toEqual({ ok: false, message: 'conflict' }); });
    // A refused write leaves no Undo behind.
    expect(hook.getCurrent().undoReceipt).toBeNull();
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-review']);
    const builtIn = SkillListItemV1Schema.parse({ skillId: 'happier:happier', name: 'happier', description: null, revision: '1:1', rules: [],
        trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 1 }, provenance: { kind: 'first_party' }, modified: false,
        updatePolicy: 'manual', createdAt: 0, migratedFromContext: false, userInvocable: true, folderId: null });
    const pickRow = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'machine',
        sessionItems: [], libraryItems: [builtIn], found: null })[0]!.rows[0]!;
    await act(async () => {
        const result = await pickSkillComposerRow(pickRow, hook.getCurrent());
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) })).toMatchObject({ ok: true });
    });
    expect(hook.getCurrent().selection.skills?.forceIncludeSkillIds).toContain('happier:happier');
    expect(hook.getCurrent().undoReceipt).toEqual({ kind: 'skill', title: 'happier', change: 'added' });
    acknowledgeApply = true;
    await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
    expect(readSessionCapabilitySelectionFromMetadataV1(metadata()).skills.forceIncludeSkillIds).toEqual([]);
    expect(metadata()?.hostPid).toBe(42);
    await act(async () => { hook.getCurrent().demandPreview(); });
    await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('ready'));
    await hook.rerender({ readOnly: false, machineOnline: true });
    await act(async () => {
        expect(await pickSkillComposerRow(pickRow, hook.getCurrent())).toMatchObject({ ok: true });
    });
    acknowledgeApply = true;
    await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
    expect(readSessionCapabilitySelectionFromMetadataV1(metadata()).skills.forceIncludeSkillIds).toEqual([]);
    await act(async () => { expect(await pickSkillComposerRow(pickRow, hook.getCurrent())).toMatchObject({ ok: true }); });
    // A pending MCP refusal must not become the timing of the skill just added.
    const bothPending = writeCapabilitySelectionApplyV1(writeSessionCapabilitySelectionToMetadataV1(metadata() ?? {},
        setSessionCapabilitySelectionItemV1(hook.getCurrent().selection, 'mcp_server', 'linear', 'on'), { sessionActive: true }),
        { mcp: { reason: 'new_sessions_only' }, skills: { reason: 'next_turn' } });
    const pendingOwner = createSessionOwnerMetadataV1({ metadata: bothPending });
    if (!pendingOwner.ok) throw new Error('Invalid pending metadata');
    row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(pendingOwner.ownerMetadata) };
    await act(async () => {
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, ownerMetadataView: metadata() } } });
    });
    expect(hook.getCurrent().model.applyNotice?.key).toBe('joinsNextTurn');
    // Simulate the external runtime's acknowledged applied selection through its real metadata codec.
    const applied = resolveSelectionRestartMarkersForStartupV1({ current: metadata() ?? {}, applied: hook.getCurrent().selection });
    const acknowledged = createSessionOwnerMetadataV1({ metadata: applied });
    if (!acknowledged.ok) throw new Error('Invalid acknowledged metadata');
    row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(acknowledged.ownerMetadata) };
    await act(async () => {
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, ownerMetadataView: metadata() } } });
    });
    expect(hook.getCurrent().model.pendingNote).toContain('happier');
    expect(hook.getCurrent().model.applyNotice).toMatchObject({ key: 'addedNow', text: hook.getCurrent().model.pendingNote });
    // The same sheet controller owns the live receipt, including a title absent from its preview.
    const dollarNotice = hook.getCurrent().model.pendingNote;
    await act(async () => { expect(await hook.getCurrent().setItem('skill', 'happier:happier', 'on', 'happier')).toMatchObject({ ok: true }); });
    expect(hook.getCurrent().model.pendingNote).toBe(dollarNotice);
    // A later rule change supersedes that old local receipt; its acknowledgment
    // must clear the single line instead of resurrecting the earlier edit.
    const rulePending = writeCapabilitySelectionApplyV1(metadata() ?? {}, { skills: { source: 'rules', reason: 'next_turn' } });
    for (const [value, key] of [[rulePending, 'pendingNextTurn'], [clearCapabilitySelectionApplyV1(rulePending, 'skills'), null]] as const) {
        const owner = createSessionOwnerMetadataV1({ metadata: value });
        if (!owner.ok) throw new Error('Invalid rule status fixture');
        row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) };
        await act(async () => getStorage().setState(current => ({ sessions: { ...current.sessions, [sessionId]: {
            ...current.sessions[sessionId]!, ownerMetadataView: metadata(),
        } } })));
        expect(hook.getCurrent().model.applyNotice?.key ?? null).toBe(key);
    }
    await hook.rerender({ readOnly: true, machineOnline: true });
    await expect(hook.getCurrent().setItem('native_skill', 'native-review', 'on')).resolves.toEqual({ ok: false, message: 'read_only' });
    await expect(hook.getCurrent().undoLast()).resolves.toEqual({ ok: false, message: 'read_only' });
    expect(hook.getCurrent().model.groups[0]?.nativeRow?.rows[0]?.action.kind).toBe('none');
});

it('says the session\'s machine is away when its check fails while it is offline, and a failure otherwise', async () => {
    const sessionId = 'c123456789012345678901299';
    const owner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'claude', startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } } });
    if (!owner.ok) throw new Error('Invalid owner fixture');
    const ownerMetadataView = MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: owner.ownerMetadata }));
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, active: true, metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView }) }, sessionLocalStateScope: { serverId, accountId: 'owner' } });
    const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
    homes.answer(serverId, 'GET /v1/artifacts', { body: [] });
    transport.mockRejectedValue(new Error('machine unreachable'));
    const target = { kind: 'session' as const, sessionId, serverId, readOnly: false };
    const hook = await renderHook<ReturnType<typeof useExistingSessionCapabilitiesPopover>, boolean | null>((machineOnline) => useExistingSessionCapabilitiesPopover(target, { ...presentation, machineOnline }),
        { initialProps: false });
    await act(async () => { hook.getCurrent().demandPreview(); });
    await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('machine_unreachable'));
    await hook.rerender(null);
    expect(hook.getCurrent().model.state).toBe('error');
    await hook.rerender(true);
    expect(hook.getCurrent().model.state).toBe('error');
    expect(transport).toHaveBeenCalledTimes(1);
});
