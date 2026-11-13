import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { canonicalSessionDraftAddressV1 } from '@happier-dev/protocol/drafts/sessionDrafts';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
vi.stubGlobal('indexedDB', new IDBFactory());
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
await loadSyncSingletonForTests();
const repository = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const persistence = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const scopeKeys = await import('@/sync/domains/scope/serverAccountScope');
const serialization = await import('@/sync/ops/sessionDrafts/sessionDraftSerializedScope');
const composer = await import('@/components/sessions/agentInput/composerTextStore');
const { useDraft } = await import('./useDraft');
const { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { SessionDraftDocumentV1Schema } = await import('@happier-dev/protocol/drafts/sessionDrafts');
const { createSessionDraftPrivatePayloadV2, SessionDraftRecordV2Schema, SESSION_DRAFT_V2_ROUTE_READ } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
const { createApiSessionDraftsTransport } = await import('@/sync/api/account/apiSessionDrafts');
const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let sessions: Map<string, Session>;
let fixtureOrdinal = 0;

beforeEach(async () => {
    sessions = new Map();
    await persistence.prepareSessionDraftPersistenceStorage();
    account = await restoreServerAccountForTest({
        serverUrl: 'https://retained-session-drafts.test', accountId: `retained-draft-account-${++fixtureOrdinal}`,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const json = (value: unknown) => Response.json(value);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            const sessionId = path.startsWith('/v2/sessions/') ? decodeURIComponent(path.slice('/v2/sessions/'.length)) : null;
            const session = sessionId ? sessions.get(sessionId) : null;
            if (session && (!init?.method || init.method === 'GET')) {
                const record = createPlainSessionCurrentProjectionRecordFixture({ id: session.id });
                const { ownerMetadata: _ownerMetadata, ...legacyRecord } = record;
                return json({ session: SessionCurrentProjectionRecordV1Schema.parse({ ...legacyRecord,
                    metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
                }) });
            }
            return new Response('{}', { status: 404 });
        },
    });
});

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    repository.resetSessionDraftRepositoryForTests();
});
afterAll(() => vi.unstubAllGlobals());

async function loadOwners() {
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected a restored Account lifetime');
    return {
        lifetime,
        repository, persistence, scopeKeys, serialization, composer, useDraft, createSessionFixture,
    };
}

describe('useDraft retained custody', () => {
    it.each([
        { seed: 'fork', switchSession: false },
        { seed: 'initial', switchSession: false },
        { seed: 'fork', switchSession: true },
        { seed: 'initial', switchSession: true },
    ] as const)('preserves unreadable retained content and $seed seed custody (Session switch: $switchSession)', async ({ seed, switchSession }) => {
        const owners = await loadOwners();
        const scope = owners.lifetime.scope;
        const address = { kind: 'session' as const, sessionId: 'retained-session' };
        owners.repository.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text: 'Retained intent' }, materializationIntent: 'seeded' });
        const original = owners.repository.getSessionDraftSnapshot(scope, address)?.document;
        if (!original) throw new Error('Expected a genuine retained Session draft');
        const storage = owners.persistence.getSessionDraftPersistenceStorage();
        const key = owners.serialization.sessionDraftRowKey(
            owners.scopeKeys.serverAccountScopedStorageKey('session-drafts-repository-v1', scope), canonicalSessionDraftAddressV1(address));
        const replica: unknown = JSON.parse(storage.getString(key)!);
        if (!replica || typeof replica !== 'object' || Array.isArray(replica)) throw new Error('Expected retained replica');
        const retainedDocument = { ...original, v: 99 };
        const repairableAcknowledgedDraft = seed === 'initial' && !switchSession;
        storage.set(key, JSON.stringify({ ...replica, localRawDocument: retainedDocument,
            ...(repairableAcknowledgedDraft ? { baseRevision: 1, baseRawDocument: retainedDocument,
                pendingFieldMutations: [], status: 'clean' } : {}),
        }));
        owners.repository.resetSessionDraftRepositoryForTests();
        const base = owners.createSessionFixture({ id: address.sessionId, serverId: scope.serverId });
        if (!base.metadata) throw new Error('Expected Session fixture metadata');
        const metadata = seed === 'fork'
            ? (await import('@/sync/domains/sessionFork/forkInitialPromptV1')).writeForkInitialPromptV1({ metadata: base.metadata, text: 'Pending seed', createdAtMs: 1 })
            : { ...base.metadata, sessionInitialPromptV1: { v: 1, text: 'Pending seed', mode: 'append', createdAtMs: 1 } as const };
        const target = { ...base, metadata };
        const previous = owners.createSessionFixture({ id: 'previous-session', serverId: scope.serverId });
        sessions.set(target.id, target);
        sessions.set(previous.id, previous);
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().setState({ sessions: { [target.id]: target, [previous.id]: previous } });
        if (switchSession) owners.repository.writeExistingSessionDraft({ scope, sessionId: previous.id, patch: { text: 'Previous unsent text' }, materializationIntent: 'seeded' });
        const textStore = owners.composer.createComposerTextStore('');
        let hostRenders = 0;
        const hook = await renderHook((session: Session) => {
            hostRenders += 1;
            owners.useDraft(session.id, textStore, { accountLifetime: owners.lifetime, session, active: true });
        }, { initialProps: switchSession ? previous : target });
        if (switchSession) {
            expect(textStore.getPrompt()).toBe('Previous unsent text');
            await hook.rerender(target);
        }
        await flushHookEffects();
        expect(owners.repository.getSessionDraftSnapshot(scope, address)?.document).toEqual(retainedDocument);
        expect(textStore.getPrompt()).toBe('');
        expect(getStorage().getState().sessions[target.id]?.metadata).toMatchObject(seed === 'fork'
            ? { forkInitialPromptV1: { text: 'Pending seed' } }
            : { sessionInitialPromptV1: { text: 'Pending seed' } });
        if (repairableAcknowledgedDraft) {
            // One genuine remote read replaces acknowledged retained custody with a readable
            // empty document. No intermediate absence may consume and then erase the seed.
            const readable = SessionDraftDocumentV1Schema.parse(original);
            const empty = { ...readable, composer: { ...readable.composer,
                text: { ...readable.composer.text, value: '' } } };
            const remoteRecord = SessionDraftRecordV2Schema.parse({ address, revision: 2, createdAt: 1, updatedAt: 2,
                content: { t: 'plain', v: createSessionDraftPrivatePayloadV2(address, empty) } });
            await act(async () => {
                await owners.repository.materializeExactSessionDraftWithScopedRuntime({ scope, address,
                    isCurrent: owners.lifetime.isCurrent,
                    runtime: {
                        transport: createApiSessionDraftsTransport({ request: async (path) => path === SESSION_DRAFT_V2_ROUTE_READ
                            ? Response.json({ status: 'present', record: remoteRecord }) : new Response('{}', { status: 404 }) }),
                        cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
                            getSessionContext: (id) => sessions.get(id)?.encryptionMode === 'plain' ? { mode: 'plain' } : null,
                            randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)) }),
                    },
                });
            });
            await flushHookEffects();
            expect(textStore.getPrompt()).toBe('Pending seed');
            expect(owners.repository.getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('Pending seed');
            const rendersBeforeTyping = hostRenders;
            await act(async () => textStore.setPrompt('Explicitly edited after recovery'));
            expect(owners.repository.getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('Explicitly edited after recovery');
            expect(hostRenders).toBe(rendersBeforeTyping);
        }
        await hook.unmount();
    });
});
