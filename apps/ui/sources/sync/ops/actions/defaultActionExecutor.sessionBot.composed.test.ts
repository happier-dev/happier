import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { V2SessionRecordSchema, type V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { generateBotFaceShape } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

// Only Home HTTP, credentials and the disconnected socket are replaced. The
// Action registration, field binding and the owner-envelope CAS remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const initialStorage = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await connection?.dispose(); connection = undefined; getStorage().setState(initialStorage, true); await homes.reset(); });

it.each([['plain', true], ['plain', false], ['e2ee', true], ['e2ee', false]] as const)(
    'publishes an ordinary Session promotion to its existing list row before rail pinning, mode=%s, detail loaded=%s', async (mode, loaded) => {
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: createAccountTokenForTests('bot-owner', { currentAccount: true }),
        ...(mode === 'e2ee' ? { secret: encodeBase64(secret, 'base64') } : {}) };
    const serverId = await homes.addHome({ name: 'Bot promotion Home', serverUrl: 'https://bot-promotion.test',
        accountId: 'bot-owner', currentAccount: true, accountEncryptionMode: mode, credentials });
    const features = createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } } });
    for (const path of ['/v1/features', '/v1/features/authenticated']) homes.answer(serverId, path, { body: features });
    const sessionId = 'c123456789012345678901234';
    const metadata = { path: '/repo', host: 'host' };
    let row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata, metadataVersion: 4 });
    if (mode === 'e2ee') {
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical plain fixture');
        const [ciphertext] = await new SecretBoxEncryption(secret).encrypt([JSON.parse(row.metadata)]);
        row = { ...row, encryptionMode: 'e2ee', dataEncryptionKey: null, metadata: encodeBase64(ciphertext!, 'base64'),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata: row.ownerMetadata.v,
                randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }) };
    }
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: mode === 'e2ee'
        ? createLegacyAccountEncryptionCurrentnessFixture({ secret })
        : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`,
        { select: () => ({ body: { session: row } }) });
    let metadataWrites = 0;
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        metadataWrites++;
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext };
        return { body: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    homes.answer(serverId, `PUT /v2/session-organization/pins/${sessionId}`, { body: {
        pin: { sessionId, sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true },
    } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://bot-promotion.test',
        accountId: 'bot-owner', credentials, request: homes.request });
    getStorage().getState().activateProfileScope({ serverId, accountId: 'bot-owner' });
    const session = createSessionFixture({ id: sessionId, serverId, metadata, metadataVersion: 4 });
    const unrelated = buildSessionListRenderableFromSession(createSessionFixture({ id: 'unrelated-session', serverId, metadata }));
    getStorage().setState({ sessions: loaded ? { [sessionId]: session } : {},
        sessionLocalStateScope: { serverId, accountId: 'bot-owner' } });
    getStorage().getState().applyServerScopedSessionListRows(serverId, [buildSessionListRenderableFromSession(session), unrelated],
        { source: 'ordinary', mode: 'replace' });
    const unrelatedBefore = getStorage().getState().sessionListRowsByServerId[serverId]?.[unrelated.id];
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui', authority: 'present_user', serverId } as const;
    expect(await executor.execute('session.bot.set', { sessionId, bot: { kind: 'bot' } }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('session.organization.pin.set', { sessionId, pinned: true, surface: 'rail' }, context))
        .toMatchObject({ ok: true, result: { pin: { railPinned: true, listPinned: false } } });
    expect(getStorage().getState().sessionListRowsByServerId[serverId]?.[sessionId]?.metadata?.bot).toEqual({ kind: 'bot' });
    expect(getStorage().getState().sessionListRowsByServerId[serverId]?.[unrelated.id]).toBe(unrelatedBefore);
    expect(metadataWrites).toBe(1);
    if (!loaded) expect(getStorage().getState().sessions[sessionId]).toBeUndefined();
});

it.each([
    ['plain', 0, true, 1, false], ['plain', 1, true, 1, false], ['e2ee', 0, true, 1, false], ['e2ee', 1, true, 1, false],
    ['plain', 0, false, 1, false], ['plain', 1, false, 1, false], ['e2ee', 0, false, 1, false], ['e2ee', 1, false, 1, false],
    ['plain', 0, false, 0, false], ['e2ee', 0, false, 0, false],
    ['plain', 0, true, 1, true], ['e2ee', 0, true, 1, true],
] as const)('commits one concrete face through %s with %i CAS conflicts, loaded=%s, layout=%i, generated=%s, and resets cosmetics without changing Bot work', async (mode, conflicts, loaded, layout, generated) => {
    const secret = new Uint8Array(32).fill(17);
    const material = { type: 'legacy' as const, secret };
    const credentials = { token: createAccountTokenForTests('bot-owner', { currentAccount: true }), secret: encodeBase64(secret, 'base64') };
    const serverId = await homes.addHome({ name: 'Face Home', serverUrl: 'https://bot-face.test', accountId: 'bot-owner', currentAccount: true,
        ...(mode === 'e2ee' ? { accountEncryptionMode: mode, credentials } : {}) });
    // New Bot work requires this Home's real enabled bit; schema defaults model an older, disabled Home.
    const features = createRootLayoutFeaturesResponse({ features: { bots: { enabled: true } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const sessionId = 'c123456789012345678901234';
    const metadata = { path: '/repo', host: 'host', bot: { kind: 'bot' as const }, botFace: { seed: 'original' }, createdAsBot: true as const,
        work: { memoryEnabled: true } };
    let row: V2SessionRecord = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata, metadataVersion: 4 });
    const sealOwner = (ownerMetadata: Parameters<typeof createPlainSessionOwnerMetadataEnvelopeV1>[0]) => mode === 'plain'
        ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
        : sealSessionOwnerMetadataEnvelopeV1({ material, ownerMetadata, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
    if (mode === 'e2ee') {
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical plain fixture');
        const [ciphertext] = await new SecretBoxEncryption(secret).encrypt([JSON.parse(row.metadata)]);
        row = { ...row, encryptionMode: 'e2ee', dataEncryptionKey: null, metadata: encodeBase64(ciphertext!, 'base64'), ownerMetadata: sealOwner(row.ownerMetadata.v) };
    }
    if (layout === 0) {
        const [ciphertext] = mode === 'e2ee' ? await new SecretBoxEncryption(secret).encrypt([metadata]) : [];
        const { ownerMetadata: _owner, displayProjectionV1: _display, ...legacy } = row;
        row = V2SessionRecordSchema.parse({ ...legacy, metadataLayoutVersion: 0,
            metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(ciphertext!, 'base64') });
    }
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: mode === 'e2ee'
        ? createLegacyAccountEncryptionCurrentnessFixture({ secret })
        : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const path = `/v2/sessions/${sessionId}`;
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { select: () => ({ body: { session: row } }) });
    let race = conflicts > 0;
    let patches = 0;
    let commits = 0;
    let upgrades = 0;
    homes.answer(serverId, `PATCH ${path}`, { select: input => {
        const patch = SessionMetadataTuplePatchV1Schema.parse(input);
        if (patch.mode === 'owner_migration') {
            upgrades++;
            row = { ...row, metadataLayoutVersion: 1, metadataVersion: row.metadataVersion + 1,
                metadata: patch.target.sharedMetadata.ciphertext, ownerMetadata: patch.target.ownerMetadata,
                agentState: patch.target.agentState.ciphertext, agentStateVersion: patch.source.agentState.version + 1 };
            return { body: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        }
        if (patch.mode !== 'owner') throw new Error('Expected owner face commit');
        patches += 1;
        if (race) {
            const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode, envelope: row.ownerMetadata,
                ...(mode === 'e2ee' ? { material } : {}) });
            if (!opened.ok) throw new Error('Expected readable concurrent owner fixture');
            row = { ...row, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: sealOwner({ ...opened.ownerMetadata, work: { ...opened.ownerMetadata.work,
                    sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Concurrent notes' } } }) };
            race = false;
            return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict',
                metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
        }
        expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
        expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
        row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext };
        commits += 1;
        return { body: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    getStorage().setState({ sessions: loaded ? { [sessionId]: createSessionFixture({ id: sessionId, serverId, metadata }) } : {},
        sessionLocalStateScope: { serverId, accountId: 'bot-owner' } });
    const executor = createDefaultActionExecutor();
    const face = { style: 'dither', body: 'spider', palette: 'lagoon', seed: 'picker-preview-seed',
        ...(generated ? { shape: generateBotFaceShape(17) } : {}) } as const;
    const requestedFace = generated ? { ...face, shape: { generate: 'surprise', seed: 17 } } : face;
    const context = { surface: 'ui', authority: 'present_user', serverId } as const;
    const faceRequests: Array<{ method: string; path: string }> = [];
    // homes.requests also includes synthetic component reads used to construct a
    // batch fixture. Count only actual fetches entering the transport adapter.
    setRuntimeFetch(async (input, init) => {
        faceRequests.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname });
        return homes.request(input, init);
    });
    const result = await executor.execute('session.bot.face.set', { sessionId, face: requestedFace }, context);
    expect(result, JSON.stringify({ result, requests: faceRequests })).toMatchObject({ ok: true, result: { face } });
    console.info('LIVING_BOTS_FACE_HTTP', JSON.stringify({ mode, conflicts, loaded, layout, admission: 'cold', requests: faceRequests }));
    const readShared = async () => mode === 'plain' ? JSON.parse(row.metadata)
        : (await new SecretBoxEncryption(secret).decrypt([decodeBase64(row.metadata, 'base64')]))[0];
    expect(await readShared()).toMatchObject({ bot: metadata.bot, botFace: face });
    expect(commits).toBe(1);
    expect(patches).toBe(1 + conflicts);
    expect(upgrades).toBe(layout === 0 ? 1 : 0);
    faceRequests.length = 0;
    expect(await executor.execute('session.bot.face.set', { sessionId, face: null }, context)).toMatchObject({ ok: true, result: { face: null } });
    console.info('LIVING_BOTS_FACE_HTTP', JSON.stringify({ mode, conflicts: 0, loaded, layout: 1, admission: 'warm', requests: faceRequests }));
    expect(await readShared()).not.toHaveProperty('botFace');
    expect(await readShared()).toMatchObject({ bot: metadata.bot });
    const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode, envelope: row.ownerMetadata,
        ...(mode === 'e2ee' ? { material } : {}) });
    expect(opened).toMatchObject({ ok: true, ownerMetadata: { work: { ...metadata.work, createdAsBot: true,
        ...(conflicts ? { sessionRolesV1: { notes: 'Concurrent notes' } } : {}) } } });
    expect(commits).toBe(2);
    expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
});

it.each([
    ['plain', 'stale'], ['plain', 'unrelated'], ['plain', 'same-field'],
    ['e2ee', 'stale'], ['e2ee', 'unrelated'], ['e2ee', 'same-field'],
] as const)(
    'uses the public guarded Bot inverse for a %s %s Home candidate through the UI Action front door', async (mode, scenario) => {
        const secret = new Uint8Array(32).fill(17);
        const material = { type: 'legacy' as const, secret };
        const credentials = { token: createAccountTokenForTests('bot-owner', { currentAccount: true }), secret: encodeBase64(secret, 'base64') };
        const serverId = await homes.addHome({ name: 'Bot Home', serverUrl: 'https://bot-owner.test', accountId: 'bot-owner', currentAccount: true,
            ...(mode === 'e2ee' ? { accountEncryptionMode: mode, credentials } : {}) });
        const sessionId = 'c123456789012345678901234';
        const metadata = { path: '/repo', host: 'host', bot: { kind: 'bot' as const }, work: { memoryEnabled: true,
            sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' } } };
        let row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata, metadataVersion: 4 });
        if (scenario === 'stale') row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: metadata.work }) };
        const sealOwner = (ownerMetadata: Parameters<typeof createPlainSessionOwnerMetadataEnvelopeV1>[0]) => mode === 'plain'
            ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
            : sealSessionOwnerMetadataEnvelopeV1({ material, ownerMetadata, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
        if (mode === 'e2ee') {
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical plain fixture');
            const [ciphertext] = await new SecretBoxEncryption(secret).encrypt([JSON.parse(row.metadata)]);
            row = { ...row, encryptionMode: 'e2ee', dataEncryptionKey: null, metadata: encodeBase64(ciphertext!, 'base64'),
                ownerMetadata: sealOwner(row.ownerMetadata.v) };
        }
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            ...(mode === 'e2ee' ? createLegacyAccountEncryptionCurrentnessFixture({ secret })
                : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) } });
        const path = `/v2/sessions/${sessionId}`;
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET ${path}${suffix}`, { select: () => ({ body: { session: row } }) });
        let race = scenario !== 'stale';
        let patches = 0;
        let commits = 0;
        homes.answer(serverId, `PATCH ${path}`, { select: input => {
            const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
            patches += 1;
            if (race) {
                row = { ...row, metadataVersion: row.metadataVersion + 1,
                    ownerMetadata: sealOwner({ v: 1, work: {
                        ...metadata.work, ...(scenario === 'unrelated' ? { bot: metadata.bot } : {}),
                        sessionRolesV1: { ...metadata.work.sessionRolesV1, notes: 'Concurrent notes' },
                    } }) };
                race = false;
                return { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict',
                    metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
            }
            expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
            expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
                ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext };
            commits += 1;
            return { body: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
        } });
        // The UI still has the accepted marker. Fresh Home state must decide.
        getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, metadata }) },
            sessionLocalStateScope: { serverId, accountId: 'bot-owner' } });
        const result = await createDefaultActionExecutor().execute('session.bot.set', { sessionId, bot: null, expectedBot: metadata.bot },
            { surface: 'ui', authority: 'present_user', serverId });
        const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode, envelope: row.ownerMetadata,
            ...(mode === 'e2ee' ? { material } : {}) });
        if (!opened.ok) throw new Error('Expected readable owner result');
        if (scenario === 'unrelated') {
            expect(result).toMatchObject({ ok: true });
            expect(commits).toBe(1);
            expect(opened.ownerMetadata).toMatchObject({ work: {
                memoryEnabled: true, sessionRolesV1: { notes: 'Concurrent notes' } } });
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'conflict' });
            expect(commits).toBe(0);
            expect(patches).toBe(scenario === 'stale' ? 0 : 1);
        }
        expect(opened.ownerMetadata).not.toHaveProperty('work.bot');
        expect(homes.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    },
);

it('distinguishes an explicit absent-marker condition from an unconditional UI write', async () => {
    const serverId = await homes.addHome({ name: 'Bot Home', serverUrl: 'https://bot-null-owner.test', accountId: 'bot-owner', currentAccount: true });
    const sessionId = 'c123456789012345678901234';
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, metadata: {
        path: '/repo', host: 'host', bot: { kind: 'bot' }, work: { memoryEnabled: true } }, metadataVersion: 4 });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
    const result = await createDefaultActionExecutor().execute('session.bot.set', { sessionId, bot: null, expectedBot: null },
        { surface: 'ui', authority: 'present_user', serverId });
    expect(result).toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(homes.requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
});
