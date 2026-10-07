/**
 * @vitest-environment jsdom
 *
 * The Voice "use a saved secret" gesture, driven the way a user drives it: a real
 * react-native-web render, the real modal host, the real picker, and a real DOM
 * click on a picker ROW — asserted all the way to the account-settings mutation
 * boundary.
 *
 * Three earlier rounds of tests passed against a feature that had never once
 * worked in the running app, because they invoked the row handler directly or
 * stopped at "a callback fired". Everything between the click and the write is
 * real here; only genuine system boundaries (the account-settings transport, the
 * console sink, and unavailable native adapters) are replaced.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import 'fake-indexeddb/auto';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
    log: vi.fn<(message: string) => void>(),
}));
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
installDisconnectedServerSocketBoundary();

vi.mock('@/log', () => ({ log: { log: boundary.log } }));

vi.mock('react-native', async () => {
    const actual: Record<string, unknown> = await vi.importActual('react-native-web');
    return {
        ...actual,
        Platform: {
            ...(actual.Platform as object ?? {}),
            OS: 'web',
            select: (values: Record<string, unknown>) =>
                values?.web ?? values?.default ?? values?.native ?? values?.ios ?? values?.android,
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', null, props.children)
    ),
}));

// Native crypto adapters are unavailable in this Node/browser harness; the
// Protocol codecs, Account-purpose encryption and settings writer stay real.
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();

const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
const { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } = await import(
    '@/voice/registry/externalVoiceProviderRegistrations'
);
const registrationToken = Object.freeze({});

const CONTRIBUTION = { pluginId: 'com.acme.voice', localId: 'conversation' } as const;

const SECRETS: SavedSecret[] = [
    {
        id: 'voice:realtime_elevenlabs:api_key',
        name: 'ElevenLabs (legacy slot id)',
        kind: 'apiKey',
        encryptedValue: {
            _isSecretValue: true,
            value: 'fixture-legacy-key',
        },
        createdAt: 1,
        updatedAt: 1,
    },
    {
        id: '2cd702f5-1111-4222-8333-444455556666',
        name: 'ElevenLabs key',
        kind: 'apiKey',
        encryptedValue: {
            _isSecretValue: true,
            value: 'fixture-live-key',
        },
        createdAt: 2,
        updatedAt: 2,
    },
];

let mounted: Readonly<{ root: Root; container: HTMLElement }> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

beforeEach(() => {
    // JSDOM lacks Web Locks; retain the real Home mutation and Account CAS owners.
    webLocks = installWebLockManagerMock();
});

afterEach(async () => {
    const current = mounted;
    mounted = null;
    if (current) {
        await act(async () => { current.root.unmount(); });
        current.container.remove();
    }
    removeExternalVoiceProviderRegistration(registrationToken);
    try {
        await account?.dispose();
    } finally {
        account = undefined;
        webLocks?.restore();
        webLocks = undefined;
        boundary.log.mockClear();
    }
});

function voiceCredentialGestureRecords(): string[] {
    return boundary.log.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('voice_credential:'));
}

function appliedVoiceBinding(): Record<string, unknown> | null {
    const bindings = account?.persistedSettings.voiceSettingsV1.credentialBindings ?? [];
    return bindings.find((binding) => (
        binding.credentialSlotId === 'api-key'
    )) ?? null;
}

function credentialDetail(): string {
    return requireNode('voice-credential').textContent ?? '';
}

function query(testID: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function requireNode(testID: string): HTMLElement {
    const node = query(testID);
    if (!node) throw new Error(`missing node for testID "${testID}"`);
    return node;
}

/** A pointer press as the browser delivers it: down, up, then the activating click. */
function pressWithPointer(node: HTMLElement): void {
    const base = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
    node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function openSavedSecretPicker(): Promise<void> {
    const trigger = requireNode('voice-credential').querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
    if (!trigger) throw new Error('missing actual Voice credential dropdown trigger');
    await act(async () => { pressWithPointer(trigger); });
    await vi.waitFor(async () => {
        await flush();
        expect(query('dropdown-option-useSavedSecret')).not.toBeNull();
    });
    await act(async () => { pressWithPointer(requireNode('dropdown-option-useSavedSecret')); });
    // The real dropdown commits after teardown on a frame (or its owning
    // fallback). Await the picker, not an invented number of event-loop turns.
    await vi.waitFor(async () => {
        await flush();
        expect(document.querySelector('[data-testid^="saved-secret:"]')).not.toBeNull();
    });
}

async function renderRow(options: Readonly<{
    credentialSourcePurpose?: string;
    initialRawSettings?: Record<string, unknown>;
    multiSource?: boolean;
    withRecipientContract?: boolean;
}> = {}): Promise<string | null> {
    const { ModalProvider } = await import('@/modal');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { VoiceCredentialItem } = await import('./CredentialItem');
    const {
        VoiceProviderContributionSchema,
        createRecipientContractDigestV1,
        normalizeRecipientContractV1,
    } = await import('@happier-dev/protocol');

    // The live ElevenLabs slot declares raw grants, so the row carries a recipient
    // contract and the gesture mounts an approval confirm between the picker
    // closing and the write. That handoff is part of the path under test.
    const recipientContract = options.withRecipientContract
        ? normalizeRecipientContractV1({
            version: 1,
            package: {
                pluginId: 'com.acme.voice',
                source: { kind: 'package', locator: '@acme/voice' },
            },
            publisher: { trust: 'verified', identity: 'npm:https://registry.npmjs.org:@acme' },
            contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
            credentialSlot: { id: 'api-key', scope: 'account' },
            operations: [{
                id: 'catalog',
                purpose: 'voice.catalog',
                credentialSlotId: 'api-key',
                effect: 'read',
                request: {
                    origin: 'https://api.elevenlabs.io',
                    pathTemplate: '/v1/voices',
                    queryTemplate: [],
                    headerTemplate: [],
                    bodyTemplate: { kind: 'none' },
                    method: 'GET',
                    credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                    redirect: 'error',
                    maxBodyBytes: 0,
                    contentTypes: [],
                },
                parameters: {
                    schema: { type: 'object', properties: {}, additionalProperties: false },
                    mapping: [],
                },
                response: { maxBytes: 32_768, contentTypes: ['application/json'] },
            }],
            presentation: { title: 'ElevenLabs' },
        })
        : null;
    const recipientContractDigest = recipientContract ? createRecipientContractDigestV1(recipientContract) : null;

    const declaration = VoiceProviderContributionSchema.parse({
        id: 'conversation',
        title: 'ElevenLabs',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: { turn: { cancelResponse: false, bargeIn: false } },
        credentials: {
            slot: { id: 'api-key', purpose: 'voice.client-auth', title: 'API key' },
            requirement: { kind: 'always' },
            sources: [{
                kind: 'savedSecret',
                secretKinds: ['apiKey'],
                rawGrants: [{
                    realm: 'web',
                    phase: 'prepare',
                    request: {
                        kind: 'httpHeaders',
                        origin: 'https://api.elevenlabs.io',
                        headerNames: ['xi-api-key'],
                    },
                }],
            }, ...(options.multiSource ? [{
                kind: 'connectedAccount' as const,
                service: { pluginId: 'com.acme.voice', localId: 'connected-account' },
                rawGrants: [{
                    realm: 'web' as const,
                    phase: 'prepare' as const,
                    request: {
                        kind: 'httpHeaders' as const,
                        origin: 'https://api.elevenlabs.io',
                        headerNames: ['xi-api-key'],
                    },
                }],
            }] : [])],
        },
        client: {
            artifactId: 'web-runtime',
            exportName: 'activate',
        },
    });

    const providerId = 'com.acme.voice/conversation';
    const descriptor = createVoiceProviderRegistry({
        bundledContributions: [{ pluginId: CONTRIBUTION.pluginId, providerId, declaration }],
        bundledPresentations: [{ providerId, settingsSectionId: 'voice.acme.conversation' }],
    }).get(providerId);
    if (!descriptor) throw new Error('saved-secret fixture declaration was not admitted');
    commitExternalVoiceProviderRegistration({
        token: registrationToken,
        ...CONTRIBUTION,
        providerId,
        descriptor,
        adapter: null,
    });

    account = await createSecretSettingsTestHarness({ mode: 'e2ee' });
    const { sync } = await import('@/sync/sync');
    const { storage } = await import('@/sync/domains/state/storage');
    const { requireOneShotAccountSettingsMutationApplied } = await import('@/sync/engine/settings/syncSettings');
    const expectedSettingsVersion = storage.getState().settingsVersion;
    if (expectedSettingsVersion === null) throw new Error('Expected loaded Account settings version');
    requireOneShotAccountSettingsMutationApplied(await sync.mutateAccountSettingsOnce({
        expectedSettingsScope: account.scope,
        expectedSettingsVersion,
        mutate: (raw) => ({
            settings: { ...raw, ...(options.initialRawSettings ?? { secrets: SECRETS }) },
            value: undefined,
        }),
    }));
    expect(JSON.stringify(account.settingsWrites)).not.toContain('fixture-live-key');
    expect(JSON.stringify(account.settingsWrites)).not.toContain('fixture-legacy-key');
    account.settingsWrites.length = 0;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
        root.render(
            <InjectedAuthProvider credentials={account!.credentials}>
                <ModalProvider>
                    <VoiceCredentialItem
                        testID="voice-credential"
                        title="ElevenLabs API Key"
                        promptTitle="ElevenLabs API Key"
                        promptDescription="Paste the key"
                        contribution={CONTRIBUTION}
                        credentialSlotId="api-key"
                        credentialSourcePurpose={options.credentialSourcePurpose}
                        credentialSourceDeclaration={declaration}
                        recipientContract={recipientContract}
                        recipientContractDigest={recipientContractDigest}
                        disclosePlainStorage={false}
                    />
                </ModalProvider>
            </InjectedAuthProvider>,
        );
    });
    return recipientContractDigest;
}

/**
 * The first render pulls in the modal host, the protocol package and the Voice
 * registry. Warmed once so a single test is not charged for the whole graph.
 */
// Modal and CredentialItem share the modal/storage graph. Loading both roots
// concurrently stalled collection in Vitest's asynchronous mock/module graph;
// finish the shared root before its consumer.
await import('@/modal');
await import('./CredentialItem');
await import('@happier-dev/protocol');
await import('@/sync/domains/settings/settings');

const CASE_TIMEOUT_MS = 180_000;

describe('Voice credential row → saved-secret picker → account-settings write', () => {
    it('writes the selected SavedSecret when a real click lands on a picker row', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedSecretPicker();

        // The picker is open and lists the account's stored records.
        const row = requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666');

        await act(async () => { pressWithPointer(row); });
        await flush();

        // Asserting the call alone is what let three rounds of tests pass against
        // a feature that never worked: the contract is the CONTENT that reached
        // the account, and that the row now reports the record as in use.
        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
        });
        expect(credentialDetail()).toContain('settingsVoice.local.voiceCredential.setOnAccount');
        expect(voiceCredentialGestureRecords()).toEqual([]);
    }, CASE_TIMEOUT_MS);

    it('writes a colon-bearing SavedSecret id unchanged', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedSecretPicker();

        await act(async () => {
            pressWithPointer(requireNode('saved-secret:voice:realtime_elevenlabs:api_key'));
        });
        await flush();

        expect(appliedVoiceBinding()).toMatchObject({
            credentialBindings: { account: { 'api-key': 'voice:realtime_elevenlabs:api_key' } },
        });
    }, CASE_TIMEOUT_MS);

    it('repairs an orphaned Connected Account purpose binding through the real picker without re-entering plaintext', async () => {
        const orphanedTarget = {
            kind: 'account' as const,
            account: {
                service: { pluginId: 'com.acme.voice', localId: 'connected-account' },
                accountId: 'connected-account-a',
            },
        };
        await renderRow({
            credentialSourcePurpose: 'voice.client-auth',
            multiSource: true,
            initialRawSettings: {
                secrets: [SECRETS[1]!],
                voiceSettingsV1: { credentialBindings: [] },
                connectedAccountPurposeBindingsV1: {
                    v: 1,
                    bindings: [{
                        purpose: {
                            consumer: CONTRIBUTION,
                            purpose: 'voice.client-auth',
                        },
                        target: orphanedTarget,
                    }],
                },
            },
        });
        const savedRecordsBefore = account!.persistedSettings.secrets;

        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
        });
        expect(account!.persistedSettings.connectedAccountPurposeBindingsV1).toEqual({
            v: 1,
            bindings: [],
        });
        expect(account!.persistedSettings.secrets).toEqual(savedRecordsBefore);
        expect(savedRecordsBefore.map((secret) => secret.id)).toEqual([SECRETS[1]!.id]);
        expect(JSON.stringify(account!.settingsWrites)).not.toContain('fixture-live-key');
    }, CASE_TIMEOUT_MS);

    it('reaches the write through the recipient-contract approval the live slot requires', async () => {
        const approvedDigest = await renderRow({ credentialSourcePurpose: 'voice.client-auth', withRecipientContract: true });
        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        const confirm = query('web-modal-confirm');
        expect(confirm, 'the recipient approval must still be readable after the picker closes').not.toBeNull();
        expect(account!.settingsWrites).toHaveLength(0);
        expect(appliedVoiceBinding()).toBeNull();
        await act(async () => { pressWithPointer(confirm!); });
        await flush();

        expect(appliedVoiceBinding()).toMatchObject({
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
            approvedRecipientContractDigest: approvedDigest,
        });
        expect(account!.settingsWrites).toHaveLength(1);
        expect(credentialDetail()).toContain('settingsVoice.local.voiceCredential.setOnAccount');
    }, CASE_TIMEOUT_MS);

    it('records one bounded failure when the Home refuses the settings compare-and-set', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        const before = account!.persistedSettings.voiceSettingsV1;
        account!.setRejectSettingsWrites(true);
        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        expect(account!.settingsWrites).toHaveLength(1);
        expect(account!.persistedSettings.voiceSettingsV1).toEqual(before);
        expect(appliedVoiceBinding()).toBeNull();
        expect(credentialDetail()).toContain('settingsVoice.local.voiceCredential.notSetOnAccount');
        expect(voiceCredentialGestureRecords()).toHaveLength(1);
        expect(voiceCredentialGestureRecords()[0]).toContain('voice_credential_source_conflict');
        expect(voiceCredentialGestureRecords()[0]).toContain('"outcome":"failed"');
    }, CASE_TIMEOUT_MS);

    /**
     * A press the picker never delivers and a deliberate cancel close the surface
     * identically. Without a record the two are the same observation — which is
     * exactly why four live sessions could not tell them apart.
     */
    it('records one bounded failure when the picker closes without a selection', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedSecretPicker();

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        await act(async () => {
            (document.activeElement ?? dialog!).dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true, cancelable: true,
            }));
        });
        await flush();

        expect(account!.settingsWrites).toHaveLength(0);
        expect(voiceCredentialGestureRecords()).toHaveLength(1);
        expect(voiceCredentialGestureRecords()[0]).toContain('saved_secret_selection_dismissed');
    }, CASE_TIMEOUT_MS);
});
