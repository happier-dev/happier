import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { createDeferred, createSessionFixture, renderHook, renderScreen } from '@/dev/testkit';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Home HTTP, device credentials and the disconnected socket are boundaries;
// the Artifact header admission, registered field owner and tuple CAS remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { sessionInstructionsActions } = await import('@/components/sessions/work/sessionWorkSources');
const { readMemoryActionOutcome } = await import('@/sync/ops/promptLibrary/memoryDocuments');
const { useSessionInstructionsDetail } = await import('@/components/sessions/work/useSessionInstructionsSource');
const { SessionContextSection } = await import('@/components/sessions/work/context/SessionContextSection');
const { SessionMemorySection } = await import('@/components/sessions/work/memory/SessionMemorySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let mountedAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await mountedAccount?.dispose(); mountedAccount = undefined; await homes.reset(); });

describe('reviewed Session context through the default UI Action host', () => {
    it.each(['memory', 'context'] as const)('does not carry a pending %s choice or late refusal into another Session', async field => {
        const serverId = await homes.addHome({ name: 'Info switches', serverUrl: 'https://info-switches.test', accountId: 'switch-owner' });
        const sessionId = 'c123456789012345678901234';
        const nextSessionId = 'c123456789012345678901235';
        const ref = { kind: 'doc', artifactId: 'notes', serverId } as const;
        const work = { memoryEnabled: true, promptStack: [{ id: 'notes', ref, enabled: true, placement: 'system_append' as const }] };
        const ownerMetadata = { v: 1 as const, work };
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify({ v: 1 }), metadataVersion: 4,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null,
            responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'notes',
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Notes' }),
            body: encodePlainArtifactStoredContent({ body: '' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const path = `/v2/sessions/${sessionId}`;
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { body: { session: row } });
        let pending = createDeferred<void>();
        homes.answer(serverId, `PATCH ${path}`, { select: () => ({ status: 403, body: { error: 'forbidden' }, respondAfter: pending.promise }) });
        const render = (id: string) => {
            const session = createSessionFixture({ id, metadataVersion: 4, metadataLayoutVersion: 1,
                ownerMetadataView: MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata })) });
            return React.createElement(InjectedAuthProvider, { credentials: null, children:
                field === 'memory' ? React.createElement(SessionMemorySection, { serverId, session })
                    : React.createElement(SessionContextSection, { serverId, session }) });
        };
        const control = field === 'memory' ? 'session-work-memory.enabled.switch' : 'session-work-context.entry.session.notes.enabled';
        const refusal = field === 'memory' ? 'session-work-memory.refused' : 'session-work-context.refused';
        const screen = await renderScreen(render(sessionId));
        try {
            await vi.waitFor(() => expect(screen.findByTestId(control)?.props.value).toBe(true));
            await act(async () => { screen.findByTestId(control)?.props.onValueChange(false); });
            await vi.waitFor(() => expect(homes.requests.some(request => request.path === path && request.input !== null
                && typeof request.input === 'object' && 'ownerMetadata' in request.input)).toBe(true));
            if (field === 'memory') {
                // The memory row owns its switch, so a save in flight is not "disabled": it takes no second choice.
                expect(screen.findByTestId(control)?.props.disabled).toBeFalsy();
                await act(async () => { screen.findByTestId(control)?.props.onValueChange(true); });
                expect(homes.requests.filter(request => request.path === path && request.input !== null
                    && typeof request.input === 'object' && 'ownerMetadata' in request.input)).toHaveLength(1);
            } else {
                expect(screen.findByTestId(control)?.props.disabled).toBe(true);
            }
            // A terminal refusal with unchanged canonical metadata must release the switch.
            await act(async () => { pending.resolve(); });
            await vi.waitFor(() => expect(Boolean(screen.findByTestId(control)?.props.disabled)).toBe(false));
            expect(screen.findByTestId(control)?.props.value).toBe(true);
            expect(screen.findByTestId(refusal)).not.toBeNull();
            pending = createDeferred<void>();
            await act(async () => { screen.findByTestId(control)?.props.onValueChange(false); });
            await vi.waitFor(() => expect(homes.requests.filter(request => request.path === path && request.input !== null
                && typeof request.input === 'object' && 'ownerMetadata' in request.input)).toHaveLength(2));
            await act(async () => { screen.update(render(nextSessionId)); });
            expect(screen.findByTestId(control)?.props.value).toBe(true);
            expect(Boolean(screen.findByTestId(control)?.props.disabled)).toBe(false);
            await act(async () => { pending.resolve(); });
            await vi.waitFor(() => expect(screen.findByTestId(refusal)).toBeNull());
        } finally { pending.resolve(); await screen.unmount(); }
    });

    it.each(['memory', 'context', 'instructions', 'voice'] as const)(
        'rejects stale %s admission, preserves unrelated retry changes and refuses competing field edits', async (field) => {
            const serverUrl = 'https://active-context-owner.test';
            const serverId = await homes.addHome({ name: 'Active Context Home', serverUrl, accountId: 'context-owner', currentAccount: true });
            const sessionId = 'c123456789012345678901234';
            const ref = { kind: 'doc', artifactId: 'memory', serverId } as const;
            const initialWork = { memoryEnabled: false, voicePreference: {
                providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'first',
            }, promptStack: [{ id: 'session.instructions', ref, enabled: true, placement: 'system_append' as const }],
                sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Original notes' } };
            let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 5,
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: initialWork }),
                agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
            await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'memory',
                header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            }) });
            homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
            const path = `/v2/sessions/${sessionId}`;
            for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { select: () => ({ body: { session: row } }) });
            let race: 'unrelated' | 'same-field' | null = 'unrelated';
            let commits = 0;
            homes.answer(serverId, `PATCH ${path}`, { select: input => {
                const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
                if (race) {
                    const competingWork = { ...initialWork, sessionRolesV1: { ...initialWork.sessionRolesV1, notes: 'Concurrent runtime notes' },
                        ...(race === 'same-field' ? field === 'memory' ? { memoryEnabled: true }
                            : field === 'voice' ? { voicePreference: { ...initialWork.voicePreference, value: 'competing' } }
                            : { promptStack: [{ ...initialWork.promptStack[0]!, enabled: false }] } : {}) };
                    row = { ...row, metadataVersion: row.metadataVersion + 1,
                        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: competingWork }) };
                    race = null;
                    return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict',
                        metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
                }
                expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
                expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
                // Metadata-only owner writes preserve an unchanged AgentState
                // version, just as the canonical server tuple producer does.
                row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                    ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
                    agentStateVersion: row.agentStateVersion! + (row.agentState === patch.agentState.ciphertext ? 0 : 1) };
                commits += 1;
                return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
            } });
            const executor = createDefaultActionExecutor();
            const target = { sessionId, serverId, expectedMetadataRevision: 4 };
            const execute = () => field === 'memory' ? executor.execute('session.memory.set', { ...target, enabled: true }, { surface: 'ui', authority: 'present_user' })
                : field === 'context' ? executor.execute('session.context.update', { ...target, intent: { kind: 'attach', entry: { id: 'own-memory', ref } } }, { surface: 'ui', authority: 'present_user' })
                : field === 'instructions' ? executor.execute('session.instructions.set', { ...target, ref: null }, { surface: 'ui', authority: 'present_user' })
                : executor.execute('session.voice.preference.set', { ...target, preference: null }, { surface: 'ui', authority: 'present_user' });
            // The caller observed revision 4; revision 5 already exists before
            // the effect owner reads anything. This is not a CAS retry race.
            const stale = await execute();
            expect(stale).toMatchObject({ ok: false, errorCode: 'conflict' });
            if (field === 'memory' || field === 'context') expect(readMemoryActionOutcome(stale)).toBe('conflict');
            expect(commits).toBe(0);
            expect(row.ownerMetadata).toEqual(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: initialWork }));
            target.expectedMetadataRevision = row.metadataVersion;
            const applied = await execute();
            expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
            expect(commits).toBe(1);
            expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Concurrent runtime notes' },
                ...(field === 'memory' ? { memoryEnabled: true } : field === 'context' ? { promptStack: [expect.anything(), expect.objectContaining({ id: 'own-memory' })] }
                    : field === 'instructions' ? { promptStack: [] } : {}) } } });
            if (field === 'voice' && row.ownerMetadata?.t === 'plain') expect(row.ownerMetadata.v.work).not.toHaveProperty('voicePreference');
            row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: initialWork }), metadataVersion: row.metadataVersion + 1 };
            mountedAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'context-owner',
                credentials: { token: createAccountTokenForTests('context-owner', { currentAccount: true }) }, request: homes.request });
            expect(mountedAccount.serverId).toBe(serverId);
            const { getStorage } = await import('@/sync/domains/state/storageStore');
            getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId,
                metadataLayoutVersion: 1, metadataVersion: row.metadataVersion,
                ownerMetadataView: MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({
                    sharedMetadata: { v: 1 }, ownerMetadata: { v: 1, work: initialWork },
                })) }) }, sessionLocalStateScope: { serverId, accountId: 'context-owner' } });
            race = 'same-field';
            target.expectedMetadataRevision = row.metadataVersion;
            expect(await execute()).toMatchObject({ ok: false, errorCode: 'conflict' });
            expect(commits).toBe(1);
            // Conflict refresh is canonical even though our write was refused.
            // An Info switch must settle to that read rather than its older mounted value.
            const projected = getStorage().getState().sessions[sessionId];
            expect(projected?.metadataVersion).toBe(row.metadataVersion);
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner fixture');
            expect(projected?.ownerMetadataView?.work).toEqual(row.ownerMetadata.v.work);
            expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);

            // Approval replay must retain the original caller basis, even though
            // the human decides after another client has changed the Session.
            const actionId = field === 'memory' ? 'session.memory.set' : field === 'context' ? 'session.context.update'
                : field === 'instructions' ? 'session.instructions.set' : 'session.voice.preference.set';
            await homes.requireUiApproval(serverId, actionId);
            target.expectedMetadataRevision = row.metadataVersion;
            const proposed = await execute();
            expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok) throw new Error('Expected an approval request');
            const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
            row = { ...row, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: initialWork }) };
            const beforeReplay = row.ownerMetadata;
            const decided = await executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' },
                { surface: 'ui', authority: 'present_user', serverId });
            expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'conflict' } } });
            expect(row.ownerMetadata).toEqual(beforeReplay);
            expect(commits).toBe(1);
        },
    );

    it('sets and undoes session capability overrides through the real owner tuple CAS while offline', async () => {
        const serverId = await homes.addHome({ name: 'Capabilities Home', serverUrl: 'https://session-capabilities-owner.test', accountId: 'capability-owner' });
        const sessionId = 'c123456789012345678901234';
        const initialOwner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'offline-machine', machineId: 'machine-1', flavor: 'codex',
            skillSelectionV1: { v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native-lint'] } } });
        if (!initialOwner.ok) throw new Error('Invalid capability metadata fixture');
        let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 4,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(initialOwner.ownerMetadata),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const path = `/v2/sessions/${sessionId}`;
        let conflictOnPatch = false;
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { select: () => ({ body: { session: row } }) });
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
            if (conflictOnPatch) {
                row = { ...row, metadataVersion: row.metadataVersion + 1 };
                return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict',
                    metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
            }
            expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
            return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        } });
        const { useSessionCapabilities } = await import('@/sync/domains/capabilities/session/useSessionCapabilities');
        const metadata = () => row.ownerMetadata?.t === 'plain' ? MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v })) : null;
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, metadataLayoutVersion: 1,
            metadata: { path: '', host: '' }, ownerMetadataView: metadata(), metadataVersion: row.metadataVersion }) },
            sessionLocalStateScope: { serverId, accountId: 'capability-owner' } });
        const hook = await renderHook(() => useSessionCapabilities(sessionId));
        expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-lint']);
        expect(hook.getCurrent().setItem).toEqual(expect.any(Function));
        await act(async () => { expect(await hook.getCurrent().setItem('native_skill', 'native-lint', 'on')).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual([]);
        expect(metadata()).toMatchObject({ skillSelectionV1: { excludeNativeSkillNames: [] } });
        await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-lint']);
        expect(metadata()).toMatchObject({ skillSelectionV1: { excludeNativeSkillNames: ['native-lint'] } });
        const skillId = 'happier:happier';
        // All three Undo states traverse the real catalog identity owner and Account CAS.
        for (const [before, next] of [['inherit', 'on'], ['on', 'off'], ['off', 'inherit']] as const) {
            await act(async () => { expect(await hook.getCurrent().setItem('skill', skillId, before)).toMatchObject({ ok: true }); });
            await act(async () => { expect(await hook.getCurrent().setItem('skill', skillId, next)).toMatchObject({ ok: true }); });
            await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
            expect(hook.getCurrent().selection.skills).toMatchObject({
                forceIncludeSkillIds: before === 'on' ? [skillId] : [],
                forceExcludeSkillIds: before === 'off' ? [skillId] : [],
                excludeNativeSkillNames: ['native-lint'],
            });
            expect(metadata()).toMatchObject({ skillSelectionV1: hook.getCurrent().selection.skills });
        }
        await act(async () => { expect(await hook.getCurrent().setItem('skill', skillId, 'on')).toMatchObject({ ok: true }); });
        const beforeFailedUndo = hook.getCurrent().selection;
        conflictOnPatch = true; // Another client wins each tuple CAS, including the owner's retries.
        await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: false, message: 'conflict' }); });
        conflictOnPatch = false;
        expect(hook.getCurrent().selection).toEqual(beforeFailedUndo);
        expect(metadata()).toMatchObject({ skillSelectionV1: { forceIncludeSkillIds: [skillId], forceExcludeSkillIds: [] } });
        await act(async () => { expect(await hook.getCurrent().undoLast()).toMatchObject({ ok: true }); });
        expect(metadata()).toMatchObject({ skillSelectionV1: { forceIncludeSkillIds: [], forceExcludeSkillIds: [skillId] } });
        await act(async () => { getStorage().setState({ sessionLocalStateScope: { serverId, accountId: 'retired-account' } }); });
        expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames ?? []).toEqual([]);
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        await hook.unmount();
    });
    it('reorders and budgets Session-owned Context from mounted controls through real Home CAS without changing Notes', async () => {
        const serverId = await homes.addHome({ name: 'Context controls', serverUrl: 'https://context-controls.test', accountId: 'controls-owner' });
        const sessionId = 'c123456789012345678901234';
        const entries = ['first', 'second'].map(id => ({ id, ref: { kind: 'doc' as const, artifactId: id, serverId },
            enabled: true, placement: 'system_append' as const }));
        let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 4,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: { memoryEnabled: false,
                sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' }, promptStack: entries } }),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const entry of entries) {
            await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                id: entry.ref.artifactId, header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: entry.id }),
                body: encodePlainArtifactStoredContent({ body: '' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            }) });
        }
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const path = `/v2/sessions/${sessionId}`;
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { select: () => ({ body: { session: row } }) });
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
            expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
            return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        } });
        const render = () => {
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata fixture');
            const session = createSessionFixture({ id: sessionId, metadataVersion: row.metadataVersion,
                metadataLayoutVersion: 1, ownerMetadataView: MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({
                    sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v,
                })),
            });
            return React.createElement(SessionContextSection, { serverId, session });
        };
        const screen = await renderScreen(render());
        try {
        let move: (() => void) | undefined;
        await vi.waitFor(() => {
            move = screen.findAllByType(ItemRowActions).flatMap(node => node.props.actions)
                .find((action: { id: string; disabled?: boolean }) => action.id === 'moveDown' && !action.disabled)?.onPress;
            expect(move).toBeDefined();
        });
        await act(async () => { move?.(); });
        await vi.waitFor(() => expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { promptStack: [{ id: 'second' }, { id: 'first' }] } } }));
        await act(async () => { screen.update(render()); });
        const budget = screen.findAllByType(ItemRowActions).flatMap(node => node.props.actions)
            .find((action: { id: string }) => action.id === 'budget.3000');
        expect(budget).toBeDefined();
        await act(async () => { budget.onPress(); });
        await vi.waitFor(() => expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
            memoryEnabled: false, sessionRolesV1: { notes: 'Keep notes' }, promptStack: [{ id: 'second', maxChars: 3000 }, { id: 'first' }],
        } } }));
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        } finally { await screen.unmount(); }
    });
    it('saves authored new-Session Instructions through the public Action before a Session exists', async () => {
        const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://instructions-draft-home.test', accountId: 'draft-owner', active: false });
        const focusedHome = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://instructions-draft-focused.test', accountId: 'focused-owner' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        const draft = { title: 'Authored empty instructions', markdown: '' };
        const requestStart = homes.requests.length;
        const created = await sessionInstructionsActions.create(serverId, draft);
        expect(created).toMatchObject({ result: { ok: true }, draft, createdRef: { kind: 'doc', serverId } });
        const id = created.createdRef?.artifactId;
        expect(id).toEqual(expect.any(String));
        expect(homes.artifacts(serverId).readPlainBody(id!)).toContain('"markdown":""');
        expect(homes.artifacts(focusedHome).readPlainBody(id!)).toBeNull();
        expect(homes.requests.slice(requestStart).some(request => /\/sessions\/|\/machines\//u.test(request.path))).toBe(false);
        await homes.requireUiApproval(serverId, 'prompt_doc.create');
        const pendingDraft = { title: 'Pending draft', markdown: 'Preserve this until accepted' };
        expect(await sessionInstructionsActions.create(serverId, pendingDraft)).toMatchObject({
            createdRef: null, draft: pendingDraft,
            result: { ok: true, result: { kind: 'approval_request_created', actionId: 'prompt_doc.create' } },
        });
    });

    it('retires accepted display when the attachment Home Account changes while the Session Home stays current', async () => {
        const documentHome = await homes.addHome({ name: 'Document Home', serverUrl: 'https://instruction-document-home.test', accountId: 'document-owner', active: false });
        const sessionHome = await homes.addHome({ name: 'Session Home', serverUrl: 'https://instruction-session-home.test', accountId: 'session-owner' });
        homes.answer(documentHome, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        await homes.artifacts(documentHome).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'private-instructions', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Private instructions' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Private document-owner content', createdAtMs: 1, updatedAtMs: 1 }) }),
        }) });
        const sessionId = 'c123456789012345678901234';
        const metadata = { work: { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'private-instructions', serverId: documentHome },
            enabled: true, required: true, placement: 'system_append' }] } };
        const address = { sessionId, serverId: sessionHome };
        const hook = await renderHook(() => useSessionInstructionsDetail({ ...address, ownerMetadata: metadata, access: 'readable' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: { markdown: 'Private document-owner content' } }));
            homes.answer(documentHome, 'GET /v1/artifacts/private-instructions', { status: 503, body: {} });
            await act(async () => { await homes.switchAccount(documentHome, 'document-owner'); });
            expect(hook.getCurrent()).toMatchObject({ document: null, stale: false });
            expect(['loading', 'unavailable']).toContain(hook.getCurrent().status);
            await homes.artifacts(documentHome).handle('/v1/artifacts/private-instructions', { method: 'POST', body: JSON.stringify({
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Current credential content', createdAtMs: 1, updatedAtMs: 2 }) }),
                expectedBodyVersion: 1,
            }) });
            const original = await homes.artifacts(documentHome).handle('/v1/artifacts/private-instructions', { method: 'GET' });
            if (!original) throw new Error('Missing current document boundary response');
            homes.answer(documentHome, 'GET /v1/artifacts/private-instructions', { body: await original.json() });
            // Join the demanded fresh read's canonical retry budget; do not shorten that lifecycle.
            await act(async () => { await hook.getCurrent().retry(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', document: {
                markdown: 'Current credential content', revision: { bodyVersion: 2 },
            } }));
            homes.answer(documentHome, 'GET /v1/artifacts/private-instructions', { status: 503, body: {} });
            await act(async () => { await homes.switchAccount(documentHome, 'replacement-account'); });
            await vi.waitFor(() => expect(hook.getCurrent().document).toBeNull());
            expect(hook.getCurrent().stale).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('admits the named Home header, preserves neighbors and retains a genuinely conflicted draft without waking compute', async () => {
        const serverId = await homes.addHome({ name: 'Context Home', serverUrl: 'https://session-context-owner.test', accountId: 'context-owner', active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://session-context-focused.test', accountId: 'focused-owner' });
        const sessionId = 'c123456789012345678901234';
        let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 4,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: { memoryEnabled: false,
                sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
                promptStack: [{ id: 'neighbor', ref: { kind: 'doc', artifactId: 'neighbor' }, enabled: true, placement: 'composer_insert' }],
            } }), agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        });
        for (const [id, header] of [
            ['instructions', { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }],
            ['dashboard', { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' }],
        ] as const) {
            const response = await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                id, header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            }) });
            expect(response?.status).toBe(200);
        }
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const path = `/v2/sessions/${sessionId}`;
        homes.answer(serverId, `GET ${path}`, { select: () => ({ body: { session: row } }) });
        homes.answer(serverId, `GET ${path}?accessProjectionVersion=1`, { select: () => ({ body: { session: row } }) });
        let commits = 0;
        let competingContextOnPatch = false;
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
            if (competingContextOnPatch) {
                if (row.ownerMetadata?.t !== 'plain') throw new Error('Missing plain owner fixture');
                row = { ...row, metadataVersion: row.metadataVersion + 1,
                    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ ...row.ownerMetadata.v,
                        work: { ...row.ownerMetadata.v.work, disabledInheritedEntryIds: ['competing-entry'] } }) };
                competingContextOnPatch = false;
                return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict',
                    metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
            }
            expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
            commits += 1;
            return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        } });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const target = { sessionId, serverId, expectedMetadataRevision: 4 };
        expect(await executor.execute('session.context.update', { ...target, intent: { kind: 'attach', entry: {
            id: 'dashboard', ref: { kind: 'bundle', artifactId: 'dashboard', serverId },
        } } }, context)).toMatchObject({ ok: false, errorCode: 'attachment_unavailable' });
        expect(commits).toBe(0);
        const ref = { kind: 'doc', artifactId: 'instructions', serverId } as const;
        expect(await sessionInstructionsActions.set(target, ref))
            .toMatchObject({ ok: true, result: { version: 5 } });
        expect(await executor.execute('session.memory.set', { ...target, expectedMetadataRevision: 5, enabled: true }, context))
            .toMatchObject({ ok: true, result: { enabled: true, version: 6 } });
        expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { memoryEnabled: true,
            sessionRolesV1: { notes: 'Keep notes' }, promptStack: [
                { id: 'neighbor', placement: 'composer_insert' }, { id: 'session.instructions', ref, required: true, placement: 'system_append' },
            ],
        } } });
        expect(JSON.parse(row.metadata)).not.toHaveProperty('work');
        const clearTarget = { sessionId, serverId, expectedMetadataRevision: 6 };
        expect(await sessionInstructionsActions.set(clearTarget, null)).toMatchObject({ ok: true, result: { version: 7 } });
        expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { memoryEnabled: true,
            sessionRolesV1: { notes: 'Keep notes' }, promptStack: [{ id: 'neighbor', placement: 'composer_insert' }],
        } } });
        const authoredDraft = { title: 'Empty instructions', markdown: '' };
        const authored = await sessionInstructionsActions.createAndAttach({ ...clearTarget, expectedMetadataRevision: 7 }, authoredDraft);
        expect(authored).toMatchObject({ result: { ok: true, result: { version: 8 } }, draft: authoredDraft,
            createdRef: { kind: 'doc', serverId } });
        expect(authored.createdRef?.artifactId).toEqual(expect.any(String));
        const createdId = authored.createdRef!.artifactId;
        expect(homes.artifacts(serverId).readPlainBody(createdId)).toContain('"markdown":""');
        competingContextOnPatch = true;
        const conflicted = await sessionInstructionsActions.createAndAttach({ ...clearTarget, expectedMetadataRevision: 8 },
            { title: 'Retained draft', markdown: 'Keep this after conflict' });
        expect(conflicted).toMatchObject({ result: { ok: false, errorCode: 'conflict' },
            draft: { title: 'Retained draft', markdown: 'Keep this after conflict' }, createdRef: { kind: 'doc', serverId } });
        expect(homes.artifacts(serverId).readPlainBody(conflicted.createdRef!.artifactId)).toContain('Keep this after conflict');
        expect(row.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { promptStack: [
            { id: 'neighbor' }, { id: 'session.instructions', ref: { artifactId: createdId, serverId }, required: true },
        ] } } });
        await homes.requireUiApproval(serverId, 'prompt_doc.create');
        const pendingDraft = { title: 'Await human decision', markdown: 'Keep until accepted' };
        const pendingCreate = await sessionInstructionsActions.createAndAttach({ ...clearTarget, expectedMetadataRevision: 8 }, pendingDraft);
        expect(pendingCreate).toMatchObject({ createdRef: null, draft: pendingDraft,
            result: { ok: true, result: { kind: 'approval_request_created', actionId: 'prompt_doc.create' } } });
        expect(row.metadataVersion).toBe(9);
        expect(new Set(homes.requestsFor(path).filter(request => request.input && typeof request.input === 'object' && 'mode' in request.input)
            .map(request => request.token))).toEqual(new Set([createAccountTokenForTests('context-owner')]));
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    });
});
