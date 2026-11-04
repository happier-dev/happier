import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExistingSessionComposerDocumentOwner } from '@/components/sessions/composer/existingSessionComposerDocumentOwner';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { storage } from '@/sync/domains/state/storageStore';
import { resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { sessionMruState } from '@/sync/domains/session/navigation/recentSessions';
import { readCaptureSessionChooserTarget } from './readCaptureSessionChooserTarget';
import { readCaptureSessionChooser } from './readCaptureSessionChooser';
import { openCaptureNewSession } from './openCaptureNewSession';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { rememberCaptureSessionPick } from './resolveCaptureDefaultTarget';

const original = storage.getState();
const homes = createHomeGovernanceHarness();
beforeAll(async () => { await loadSyncSingletonForTests(); await prepareSessionDraftPersistenceStorage(); });
beforeEach(() => {
    clearPersistenceStorage();
    resetSessionSurfaceVisibilityForTests();
    sessionMruState.set('order', []);
    storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, machineRecordsByServerId: {},
        sessionListRowsByServerId: {
            'home-a': { same: createSessionListRenderableSessionFixture({ id: 'same', metadata: { name: 'Home A', path: '/repo' } }) },
            'home-b': { same: createSessionListRenderableSessionFixture({ id: 'same', metadata: { name: 'Home B', path: '/repo' } }) },
        }, ordinarySessionListMembershipByServerId: { 'home-a': ['same'], 'home-b': ['same'] } });
});
afterEach(async () => {
    resetSessionSurfaceVisibilityForTests(); sessionMruState.set('order', []);
    resetSessionDraftRepositoryForTests();
    await homes.reset();
    storage.setState(original, true);
});

describe('readCaptureSessionChooserTarget', () => {
    it('uses the default-target owner pick and exposes why it won to a new Capture window', async () => {
        setFocusedSessionId('same', 'home-a');
        rememberCaptureSessionPick({ serverId: 'home-b', sessionId: 'same' });
        await expect(readCaptureSessionChooserTarget({})).resolves.toMatchObject({
            address: { serverId: 'home-b', sessionId: 'same' }, defaultReason: 'lastCapturePick', row: { label: 'Home B' },
        });
        await expect(readCaptureSessionChooserTarget({ targetSession: { serverId: 'home-a', sessionId: 'same' } }))
            .resolves.toMatchObject({ address: { serverId: 'home-a', sessionId: 'same' }, row: { label: 'Home A' } });
    });
    it('loads the two Capture request entries with mini schemas and preserves their strict input admission', async () => {
        await expect(readCaptureSessionChooser({ kind: 'target', targetSession: { serverId: ' home-b ', sessionId: ' same ' } }))
            .resolves.toMatchObject({ address: { serverId: 'home-b', sessionId: 'same' }, row: { label: 'Home B' } });
        for (const input of [
            { kind: 'page', query: '', offset: -1, limit: 1 },
            { kind: 'page', query: '', offset: 0, limit: 0 },
            { kind: 'target', includeWindowText: true },
        ]) await expect(readCaptureSessionChooser(input)).rejects.toThrow();
        for (const input of [{ captureRef: '  ' }, { captureRef: 'capture', includeWindowText: true }]) {
            await expect(openCaptureNewSession(input)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
        }
    });

    it('joins default and explicit targets to the exact Home row through the real availability reader', async () => {
        setFocusedSessionId('same', 'home-a');
        await expect(readCaptureSessionChooserTarget({})).resolves.toMatchObject({
            address: { serverId: 'home-a', sessionId: 'same' }, row: { label: 'Home A', address: { serverId: 'home-a', sessionId: 'same' } },
            uploadAvailable: false, machineReachability: 'unknown', hasDraftText: false,
        });
        await expect(readCaptureSessionChooserTarget({ targetSession: { serverId: 'home-b', sessionId: 'same' } })).resolves.toMatchObject({
            address: { serverId: 'home-b', sessionId: 'same' }, row: { label: 'Home B', address: { serverId: 'home-b', sessionId: 'same' } },
            uploadAvailable: false, machineReachability: 'unknown', hasDraftText: false,
        });
    });

    it('preserves an admitted missing explicit address without redirecting it to the focus', async () => {
        setFocusedSessionId('same', 'home-a');
        await expect(readCaptureSessionChooserTarget({ targetSession: { serverId: 'home-b', sessionId: 'missing' } })).resolves.toEqual({
            address: { serverId: 'home-b', sessionId: 'missing' }, accountId: null, row: null, uploadAvailable: false, machineReachability: 'unknown', hasDraftText: false,
        });
    });

    it('reads prose outside exact reference ranges from the chosen Home document, not another Home', async () => {
        const homeA = await homes.addHome({ name: 'A', serverUrl: 'https://capture-draft-a.test', accountId: 'alice' });
        const homeB = await homes.addHome({ name: 'B', serverUrl: 'https://capture-draft-b.test', accountId: 'bob' });
        storage.setState({ sessionListRowsByServerId: {
            [homeA]: { same: createSessionListRenderableSessionFixture({ id: 'same' }) },
            [homeB]: { same: createSessionListRenderableSessionFixture({ id: 'same' }) },
        }, ordinarySessionListMembershipByServerId: { [homeA]: ['same'], [homeB]: ['same'] } });
        const ownerA = createExistingSessionComposerDocumentOwner({ scope: { serverId: homeA, accountId: 'alice' }, ref: { kind: 'session', sessionId: 'same' } });
        const ownerB = createExistingSessionComposerDocumentOwner({ scope: { serverId: homeB, accountId: 'bob' }, ref: { kind: 'session', sessionId: 'same' } });
        const chip = '@Image#1';
        const chipOnly = { text: ` \n${chip}  `, structuredInputMentions: [
            { kind: 'reference', ref: 'attachment:pending-image', tokenText: chip, start: 2, end: 2 + chip.length },
        ], composerAttachments: [] } as const;
        ownerA.replaceDocument({ ...chipOnly, text: `${chipOnly.text}\nExplain this result` });
        ownerB.replaceDocument(chipOnly);
        const read = (serverId: string) => readCaptureSessionChooserTarget({ targetSession: { serverId, sessionId: 'same' } });

        expect((await read(homeA)).hasDraftText).toBe(true);
        expect((await read(homeB)).hasDraftText).toBe(false);
        ownerA.replaceDocument(chipOnly);
        expect((await read(homeA)).hasDraftText).toBe(false);
        ownerA.replaceDocument({ ...chipOnly, text: `${chipOnly.text}\nEarlier capture note` });
        expect((await read(homeA)).hasDraftText).toBe(true);
        ownerA.clear('discarded');
        expect((await read(homeA)).hasDraftText).toBe(false);
        ownerA.replaceDocument({ text: chip, structuredInputMentions: [], composerAttachments: [] });
        expect((await read(homeA)).hasDraftText).toBe(true);
    });
});
