import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { createSessionFixture, renderHook, renderScreen } from '@/dev/testkit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Home HTTP, device credentials and the disconnected socket are boundaries;
// the Artifact header admission, registered field owner and tuple CAS remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { sessionInstructionsActions } = await import('@/components/sessions/work/sessionWorkSources');
const { useSessionInstructionsDetail } = await import('@/components/sessions/work/useSessionInstructionsSource');
const { SessionContextSection } = await import('@/components/sessions/work/context/SessionContextSection');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await homes.reset(); });

describe('reviewed Session context through the default UI Action host', () => {
    it('reorders and budgets Session-owned Context from mounted controls through real Home CAS without changing Notes', async () => {
        const serverId = await homes.addHome({ name: 'Context controls', serverUrl: 'https://context-controls.test', accountId: 'controls-owner' });
        const sessionId = 'c123456789012345678901234';
        const entries = ['first', 'second'].map(id => ({ id, ref: { kind: 'doc', artifactId: id, serverId },
            enabled: true, placement: 'system_append' }));
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
            const session = createSessionFixture({ id: sessionId, metadataVersion: row.metadataVersion });
            return React.createElement(SessionContextSection, { serverId, session: {
                ...session, metadata: { ...session.metadata, ...row.ownerMetadata.v },
            } });
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

    it('admits the named Home header, preserves neighbors and refuses a stale reviewed draft without waking compute', async () => {
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
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
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
        const draft = { kind: 'inherited_enable', entryId: 'account-entry', enabled: false };
        expect(await executor.execute('session.context.update', { ...target, intent: draft }, context))
            .toMatchObject({ ok: false, errorCode: 'conflict' });
        expect(commits).toBe(1);
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
        const conflicted = await sessionInstructionsActions.createAndAttach({ ...clearTarget, expectedMetadataRevision: 7 },
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
        expect(row.metadataVersion).toBe(8);
        expect(new Set(homes.requestsFor(path).filter(request => request.input && typeof request.input === 'object' && 'mode' in request.input)
            .map(request => request.token))).toEqual(new Set([createAccountTokenForTests('context-owner')]));
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    });
});
