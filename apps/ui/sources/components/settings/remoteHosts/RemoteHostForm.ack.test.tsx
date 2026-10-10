import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

afterEach(async () => {
    await standardCleanup();
    await home.reset();
});

it('preserves newer draft edits when an older submitted editor closure receives the host save acknowledgement', async () => {
    // Owners load after the genuine Home HTTP and device credential boundaries.
    const { useRemoteHostEditor } = await import('./RemoteHostForm');
    const { withProfileAccount } = await import('@/sync/api/account/apiProfileCatalog');
    const { saveRemoteHostInContext } = await import('@/sync/api/account/apiRemoteHostCatalog');
    const serverId = await home.addHome({ name: 'Editor Home', serverUrl: 'https://editor-ack.test', accountId: 'editor-account' });
    const scope = { serverId, accountId: 'editor-account' };
    const host = { id: 'edited-host', name: 'Original host', createdAt: 1, updatedAt: 1, lastUsedAt: null,
        ssh: { target: 'dev@original.example', authMode: 'password' as const } };
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    const writeReached = createDeferred<void>();
    const acknowledge = createDeferred<void>();
    home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: () => {
        writeReached.resolve();
        return { respondAfter: acknowledge.promise, body: { status: 'updated', revision: 5, cursor: 1 } };
    } });
    const editor = await renderHook(() => useRemoteHostEditor({ remoteHost: host, localOverrides: null, secretMaterialAllowed: false }));
    await act(async () => { editor.getCurrent().setState(current => ({ ...current, name: 'Submitted host',
        sshDraft: { ...current.sshDraft, password: 'submitted-one-time-password' } })); });
    const submittedEditor = editor.getCurrent();
    const payload = submittedEditor.buildSavePayload();
    if (!payload) throw new Error('Expected a valid submitted draft');
    const saving = withProfileAccount(scope, undefined, context => saveRemoteHostInContext(context,
        { host: payload.remoteHost, expectedRevision: 4 }));
    const settled = saving.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
        await Promise.race([writeReached.promise, settled.then(outcome => {
            if (!outcome.ok) throw outcome.error;
            throw new Error('Save settled before reaching its HTTP acknowledgement boundary');
        })]);
        await act(async () => { editor.getCurrent().setState(current => ({ ...current, name: 'Typed while save was pending',
            sshDraft: { ...current.sshDraft, password: 'replacement-one-time-password' } })); });
        await act(async () => {
            acknowledge.resolve();
            const outcome = await settled;
            if (!outcome.ok) throw outcome.error;
            expect(outcome.value).toEqual({ ok: true, revision: 5 });
            submittedEditor.markSaved();
        });
        expect(editor.getCurrent().state).toMatchObject({ name: 'Typed while save was pending',
            sshDraft: { password: 'replacement-one-time-password' } });
        expect(editor.getCurrent().dirty).toBe(true);
        // Discard returns to the acknowledged submission, without reviving its retired transient material.
        await act(async () => { editor.getCurrent().discard(); });
        expect(editor.getCurrent().state).toMatchObject({ name: 'Submitted host', sshDraft: { password: '' } });
        expect(editor.getCurrent().dirty).toBe(false);
    } finally {
        acknowledge.resolve();
        await settled;
    }
});
