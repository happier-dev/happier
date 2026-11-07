import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
    const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary();
});
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema,
    SessionMetadataVersionConflictV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { areSessionCapabilitySelectionsEquivalentV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useExistingSessionCapabilitiesPopover } from './useSessionCapabilitiesPopover';
import { CLOSED_DETAIL } from './useSessionCapabilitiesDetail';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
await loadSyncSingletonForTests();

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
});

it('keeps each queued capability write and Undo caller while UI writes still reach the Session', async () => {
    const sessionId = 'c123456789012345678901234';
    const initial = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'QA', machineId: 'machine', flavor: 'codex',
        startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } },
        skillSelectionV1: { v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native-review'] } } });
    if (!initial.ok) throw new Error('Invalid Session owner fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(initial.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    const metadata = () => row.ownerMetadata?.t === 'plain' ? MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v })) : null;
    let releasePatch: (() => void) | undefined;
    let firstPatch = true;
    let capabilityWriteCount = 0;
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://capability-invocation.test', accountId: 'owner',
        settings: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'session.capabilities.set': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { 'session.capabilities.set': ['ui'] } }) } }], route: async request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v1/artifacts') return Response.json([]);
        if (request.path !== `/v2/sessions/${sessionId}`) return undefined;
        if (request.method === 'GET') return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse(row) });
        if (request.method !== 'PATCH') return undefined;
        const patch = SessionMetadataOwnerPatchV1Schema.parse(request.body);
        if (firstPatch) {
            firstPatch = false;
            await new Promise<void>(resolve => { releasePatch = resolve; });
        }
        if (patch.sharedMetadata.expectedVersion !== row.metadataVersion || patch.agentState.expectedVersion !== row.agentStateVersion) {
            return Response.json(SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }), { status: 409 });
        }
        const before = readSessionCapabilitySelectionFromMetadataV1(metadata());
        row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
            metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
            agentStateVersion: row.agentStateVersion! + Number(patch.agentState.ciphertext !== row.agentState),
            ...('displayProjectionV1' in patch ? { displayProjectionV1: patch.displayProjectionV1 ?? undefined } : {}) });
        if (!areSessionCapabilitySelectionsEquivalentV1(before, readSessionCapabilitySelectionFromMetadataV1(metadata()))) capabilityWriteCount += 1;
        return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion },
            agentState: { version: row.agentStateVersion } }));
    } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: server.id, active: true,
        metadataLayoutVersion: 1, metadata: { path: '', host: '' }, ownerMetadataView: metadata() }) },
        sessionLocalStateScope: { serverId: server.id, accountId: 'owner' } });
    const results: Array<Readonly<{ source: string; result: Readonly<{ ok: boolean; message?: string }> }>> = [];
    const record = (source: string, promise: Promise<Readonly<{ ok: boolean; message?: string }>>) => {
        void promise.then(result => { results.push({ source, result }); });
    };
    function Capabilities() {
        const owner = useExistingSessionCapabilitiesPopover({ kind: 'session', sessionId, serverId: server.id, readOnly: false },
            { ...CLOSED_DETAIL, machineOnline: true, machineName: 'QA', turnSettled: true });
        const commands: readonly CurrentUiContextLocalCommand[] = [
            { key: 'remove', title: 'Remove skill', description: 'skills.remove', invoke: (_input, _context, invocation) => {
                record('agent-remove', owner.setItem('native_skill', 'native-review', 'off', undefined, invocation));
            } },
            { key: 'undo', title: 'Undo skill change', description: 'skills.undo', invoke: (_input, _context, invocation) => {
                record('agent-undo', owner.undoLast(invocation));
            } },
        ];
        useCurrentUiContextLocalCommands(commands);
        return <>
            <Pressable testID="skills-on" onPress={() => record('ui-on', owner.setItem('native_skill', 'native-review', 'on'))} />
            <Pressable testID="skills-off" onPress={() => record('ui-off', owner.setItem('native_skill', 'native-review', 'off'))} />
            <Pressable testID="skills-undo" onPress={() => record('ui-undo', owner.undoLast())} />
        </>;
    }
    const screen = await renderMountedCurrentUiContext(<Capabilities />);
    const executor = createDefaultActionExecutor();
    const invoke = async (description: string) => {
        const command = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands
            .find(candidate => candidate.description === description);
        expect(command, description).toBeDefined();
        await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
    };
    await screen.pressByTestIdAsync('skills-on');
    await vi.waitFor(() => expect(releasePatch).toBeDefined());
    await invoke('skills.remove');
    await screen.pressByTestIdAsync('skills-off');
    await act(async () => { releasePatch!(); });
    await vi.waitFor(() => expect(results).toHaveLength(3));
    expect(results).toEqual([
        { source: 'ui-on', result: { ok: true, state: 'on', previous: 'off' } },
        { source: 'agent-remove', result: { ok: false, message: 'action_disabled' } },
        { source: 'ui-off', result: { ok: true, state: 'off', previous: 'inherit' } },
    ]);
    expect(capabilityWriteCount).toBe(2);
    expect(readSessionCapabilitySelectionFromMetadataV1(metadata()).skills.excludeNativeSkillNames).toEqual(['native-review']);
    await invoke('skills.undo');
    await vi.waitFor(() => expect(results).toHaveLength(4));
    expect(results[3]).toEqual({ source: 'agent-undo', result: { ok: false, message: 'action_disabled' } });
    expect(capabilityWriteCount).toBe(2);
    await screen.pressByTestIdAsync('skills-undo');
    await vi.waitFor(() => expect(results).toHaveLength(5));
    expect(results[4]?.source).toBe('ui-undo');
    expect(results[4]?.result.ok).toBe(true);
    expect(readSessionCapabilitySelectionFromMetadataV1(metadata()).skills.excludeNativeSkillNames).toEqual([]);
});
