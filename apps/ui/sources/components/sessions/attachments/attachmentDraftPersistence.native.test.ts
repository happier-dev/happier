import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOptionalNativeModuleForTests } from '@/dev/expoModulesCoreStub';
import { installQuickBase64Boundary } from '@/dev/testkit/mocks/quickBase64';
import type { AttachmentDraft } from './attachmentDraftModel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({
    platformOS: process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM === 'ios' ? 'ios' : 'android',
}));
// Preserve the installed SDK's JavaScript validation; replace only its OS keychain module.
vi.unmock('expo-secure-store');
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const secureValues = new Map<string, string>();
let secureFailure = false;
const removeSecureBoundary = installOptionalNativeModuleForTests('ExpoSecureStore', {
    getValueWithKeyAsync: async (key: string) => {
        if (secureFailure) throw new Error('Keychain unavailable');
        return secureValues.get(key) ?? null;
    },
    setValueWithKeyAsync: async (value: string, key: string) => { secureValues.set(key, value); },
    deleteValueWithKeyAsync: async (key: string) => { secureValues.delete(key); },
});
afterEach(() => { secureFailure = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => removeSecureBoundary());
beforeEach(installQuickBase64Boundary);

const scope = { serverId: 'native-recovery-home', accountId: 'native-recovery-account' };
const draft: AttachmentDraft = { id: 'native-picture', status: 'pending', source: {
    kind: 'memory', name: 'annotated.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]),
} };

describe.skipIf(!process.env.HAPPIER_UI_TEST_NATIVE_PLATFORM)('native attachment recovery with the installed SecureStore SDK', () => {
    it('seals an image and restores its exact bytes through native crypto and MMKV', async () => {
        const owner = await import('./attachmentDraftPersistence');
        vi.stubGlobal('Buffer', undefined); // Hermes reaches the native base64 adapter without Node globals.
        await owner.writeAttachmentDraftRecord('native-done-success', scope, [draft]);
        const restored = await owner.readAttachmentDraftRecord('native-done-success', scope);
        expect(restored[0]?.source).toMatchObject(draft.source);
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const records = getPersistenceStorage();
        const saved = records.getAllKeys().filter(key => key.includes('native-done-success')).map(key => records.getString(key));
        expect(saved).toHaveLength(2);
        expect(saved.every(value => !value?.includes('annotated.png'))).toBe(true);
    });

    it('settles a keychain failure as an observable draft error and rejected flush', async () => {
        secureFailure = true;
        const owner = await import('./attachmentDraftMemoryStore');
        const key = 'native-done-failed-storage';
        owner.bindAttachmentDraftPersistence(key, { ...scope, accountId: 'unavailable-keychain' });
        owner.writeAttachmentDraftsForKey(key, [draft]);
        await expect(owner.flushAttachmentDraftsForKey(key)).rejects.toThrow();
        expect(owner.readAttachmentDraftsForKey(key)[0]).toMatchObject({
            status: 'error', errorCode: 'attachment_persistence_failed',
        });
    });
});
