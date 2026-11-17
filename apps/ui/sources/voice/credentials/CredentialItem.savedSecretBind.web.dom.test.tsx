/**
 * @vitest-environment jsdom
 *
 * The Voice "use a saved secret" gesture, driven the way a user drives it: a real
 * react-native-web render, the real modal host, the real Connect sheet, and a real DOM
 * click on a Saved row followed by Use — asserted all the way to the account-settings mutation
 * boundary.
 *
 * Three earlier rounds of tests passed against a feature that had never once
 * worked in the running app, because they invoked the row handler directly or
 * stopped at "a callback fired". Everything between the click and the write is
 * real here; only genuine system boundaries (the account-settings transport
 * and unavailable native adapters) are replaced.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import 'fake-indexeddb/auto';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let credentialChanged = createDeferred<void>();
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

// The real RNW press/focus path is this suite's contract. The renderer testkit's
// named host components cannot deliver browser pointer events or modal focus.
vi.mock('react-native', () => vi.importActual('react-native-web'));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

// Native crypto adapters are unavailable in this Node/browser harness; the
// Protocol codecs, Account-purpose encryption and settings writer stay real.
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();
const { t } = await import('@/text');
const { log } = await import('@/log');

const { createVoiceProviderRegistry, projectVoiceProviderAccountCredentialSlot } = await import('@/voice/registry/providerRegistry');
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
    log.clear();
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
        log.clear();
    }
});

function voiceCredentialGestureRecords(): string[] {
    return log.getLogs()
        .filter((message) => message.includes('voice_credential:'));
}

async function waitForCredentialChange(): Promise<void> {
    let unsubscribe = () => {};
    try {
        await act(async () => {
            await Promise.race([credentialChanged.promise, new Promise<never>((_resolve, reject) => {
                const check = () => {
                    const records = voiceCredentialGestureRecords();
                    if (records.length) reject(new Error(`Credential gesture failed: ${JSON.stringify(records)}`));
                };
                unsubscribe = log.onChange(check);
                check();
            })]);
        });
    } finally { unsubscribe(); }
}

async function waitForCredentialFailure(): Promise<void> {
    await act(async () => {
        await waitForTestEvent(listener => log.onChange(listener), voiceCredentialGestureRecords, records => records.length > 0);
    });
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

function importedSecretRef(personalId: string): string {
    const source = SECRETS.find(secret => secret.id === personalId);
    const resource = account?.resources.find(material => 'name' in material.entry && material.entry.name === source?.name);
    if (!resource || !('ref' in resource.entry)) throw new Error(`Missing acknowledged fixture Resource for ${personalId}`);
    return resource.entry.ref;
}

function query(testID: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function subscribeDomMutations(notify: () => void): () => void {
    const observer = new MutationObserver(notify);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
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

async function openConnectSheet(): Promise<void> {
    const row = requireNode('voice-credential');
    const trigger = row.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button') ?? row;
    await act(async () => { pressWithPointer(trigger); });
    // Bound slots offer Replace; an unbound slot goes straight to Connect.
    await waitForTestEvent(subscribeDomMutations,
        () => query('dropdown-option-useSavedSecret') ?? query('connect-key-sheet'), node => node !== null);
    if (query('dropdown-option-useSavedSecret')) {
        await act(async () => { pressWithPointer(requireNode('dropdown-option-useSavedSecret')); });
    }
    await waitForTestEvent(subscribeDomMutations, () => query('connect-key-sheet'), node => node !== null);
}

async function chooseKeyMode(mode: 'new' | 'saved'): Promise<void> {
    await waitForTestEvent(subscribeDomMutations,
        () => query(`connect-key-sheet:mode:${mode}`) ?? query('connect-key-sheet:mode:select'), node => node !== null);
    const segment = query(`connect-key-sheet:mode:${mode}`);
    await act(async () => { pressWithPointer(segment ?? requireNode('connect-key-sheet:mode:select')); });
    // The responsive value control uses its real dropdown when no tab width
    // fits the DOM harness; both renderings belong to SegmentedTabBar.
    if (!segment) {
        await waitForTestEvent(subscribeDomMutations,
            () => query(`connect-key-sheet:mode:select:${mode}`), node => node !== null);
        await act(async () => { pressWithPointer(requireNode(`connect-key-sheet:mode:select:${mode}`)); });
    }
}

async function openSavedKeys(): Promise<void> {
    await openConnectSheet();
    if (!query('connect-key-sheet:saved')) await chooseKeyMode('saved');
    await waitForTestEvent(subscribeDomMutations, () => query('connect-key-sheet:saved'), node => node !== null);
}

async function selectSavedSecret(ref: string): Promise<void> {
    await act(async () => { pressWithPointer(requireNode(`connect-key-sheet:saved:${ref}`)); });
    expect(requireNode(`connect-key-sheet:saved:${ref}`).getAttribute('aria-checked')).toBe('true');
    expect(requireNode('connect-key-sheet:use').getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { pressWithPointer(requireNode('connect-key-sheet:use')); });
}

async function enterNewKey(value: string): Promise<void> {
    await openConnectSheet();
    await waitForTestEvent(subscribeDomMutations,
        () => query('saved-secret-create-value') ?? query('connect-key-sheet:mode:new') ?? query('connect-key-sheet:mode:select'), node => node !== null);
    if (!query('saved-secret-create-value')) await chooseKeyMode('new');
    await waitForTestEvent(subscribeDomMutations, () => query('saved-secret-create-value'), node => node !== null);
    const input = requireNode('saved-secret-create-value') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe(value);
    expect(requireNode('saved-secret-create-submit').getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { pressWithPointer(requireNode('saved-secret-create-submit')); });
}

async function renderRow(options: Readonly<{
    mode?: 'plain' | 'e2ee';
    connectedPurposes?: ConnectedPurposeCatalogV1;
    credentialSourcePurpose?: string;
    initialRawSettings?: Record<string, unknown>;
    multiSource?: boolean;
    withRecipientContract?: boolean;
    approvalRequired?: boolean;
    onChanged?: () => void;
}> = {}): Promise<string | null> {
    credentialChanged = createDeferred<void>();
    const { ModalProvider } = await import('@/modal');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { VoiceCredentialItem } = await import('./CredentialItem');
    const [{ VoiceProviderContributionSchema}, { createRecipientContractDigestV1, normalizeRecipientContractV1}] = await Promise.all([import('@happier-dev/protocol/plugins/contributions/voice'), import('@happier-dev/protocol/plugins/recipientContractV1')]);

    // The live ElevenLabs slot declares raw grants. The real declared recipient
    // contract stays on the settings Action path when Connect selects a key.
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
            ...(recipientContract ? { hostMediated: { operations: recipientContract.operations } } : {}),
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
        descriptor: recipientContract ? { ...descriptor, accountCredentialSlot:
            projectVoiceProviderAccountCredentialSlot(declaration, recipientContract) ?? undefined } : descriptor,
        adapter: null,
    });

    // The boundary's full personal-promotion transaction is Plain. E2EE
    // material admission is exercised by the canonical resource-owner suites.
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const initialSettings = settingsParse({
        actionsSettingsV1: { v: 1, ...(options.approvalRequired
            ? { actions: { 'secrets.create': { approvalRequiredSurfaces: ['ui'] } } }
            : { approvalWaivedSurfaces: { 'secrets.create': ['ui'], 'secrets.shared.promote': ['ui'], 'secrets.shared.create': ['ui'] } }) },
        ...(options.initialRawSettings ?? { secrets: SECRETS }),
    });
    account = await createSecretSettingsTestHarness({ voiceEnabled: true, mode: options.mode ?? 'plain', approvalRequired: options.approvalRequired,
        // Historical personal-secret bytes come from HTTP, never a new unsealed write.
        settings: initialSettings, rawSettings: initialSettings,
        connectedPurposes: options.connectedPurposes ?? { v: 1, bindings: [] } });
    const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    await refreshSavedSecretCatalog(account.scope);
    // Foreground catalog readiness precedes legacy-source cleanup. Establish
    // that fixture migration before measuring or refusing the user's write.
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForTestEvent(storage.subscribe, () => storage.getState().settings.secrets.length === 0
        && account!.persistedSettings.secrets.length === 0, complete => complete);
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
                        disclosePlainStorage={false}
                        onChanged={() => { options.onChanged?.(); credentialChanged.resolve(); }}
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

describe('Voice credential row → Connect → account-settings write', () => {
    it.each(['not-required', 'executed', 'canceled'] as const)('saves a new dormant binding without changing the Connected Account source (approval: %s)', async approval => {
        const approvalRequired = approval !== 'not-required';
        const onChanged = vi.fn();
        const purpose: ConnectedPurposeCatalogV1 = {
            v: 1,
            bindings: [{
                purpose: { consumer: CONTRIBUTION, purpose: 'voice.client-auth' },
                target: {
                    kind: 'account',
                    account: {
                        service: { pluginId: 'com.acme.voice', localId: 'connected-account' },
                        accountId: 'connected-account-a',
                    },
                },
            }],
        };
        await renderRow({
            mode: 'plain',
            approvalRequired,
            onChanged,
            connectedPurposes: purpose,
            multiSource: true,
            initialRawSettings: {
                secrets: [],
                voiceSettingsV1: {
                    credentialBindings: [{
                        contribution: CONTRIBUTION,
                        credentialSlotId: 'api-key',
                        credentialSource: { kind: 'connectedAccount' },
                        credentialBindings: { account: {} },
                    }],
                },
            },
        });
        await enterNewKey('fixture-new-dormant-key');
        if (approvalRequired) {
            await waitForTestEvent(subscribeDomMutations,
                () => query('actions.confirmation-review.decision-approve'), node => node !== null);
            await flush();
            expect(voiceCredentialGestureRecords()).toEqual([]);
            expect(account!.creations).toHaveLength(0);
            expect(account!.settingsWrites).toHaveLength(0);
            expect(appliedVoiceBinding()).toMatchObject({ credentialSource: { kind: 'connectedAccount' }, credentialBindings: { account: {} } });
            expect(requireNode('saved-secret-create-submit').getAttribute('aria-disabled')).toBe('true');
            await act(async () => { pressWithPointer(requireNode('saved-secret-create-submit')); });
            await flush();
            expect(query('saved-secret-create-value')).not.toBeNull();
            await act(async () => {
                pressWithPointer(requireNode(approval === 'executed'
                    ? 'actions.confirmation-review.decision-approve'
                    : 'actions.confirmation-review.decision-reject'));
            });
            if (approval === 'canceled') {
                await waitForTestEvent(subscribeDomMutations, () => {
                    const submit = query('saved-secret-create-submit');
                    return submit !== null && submit.getAttribute('aria-disabled') !== 'true' && !submit.hasAttribute('disabled');
                }, ready => ready);
                expect(voiceCredentialGestureRecords()).toEqual([]);
                expect(account!.settingsWrites).toHaveLength(0);
                expect(account!.creations).toHaveLength(0);
                expect(onChanged).not.toHaveBeenCalled();
                expect(appliedVoiceBinding()).toMatchObject({ credentialSource: { kind: 'connectedAccount' }, credentialBindings: { account: {} } });
                return;
            }
            await waitForCredentialChange();
            expect(onChanged).toHaveBeenCalledOnce();
            expect(account!.creations).toHaveLength(1);
            expect(account!.resources[0]?.entry).toMatchObject({ ref: `happier:shared-secret:v1:${account!.creations[0]!.resourceId}` });
        }
        await waitForCredentialChange();
        const binding = appliedVoiceBinding();
        expect(binding).toMatchObject({ credentialSource: { kind: 'connectedAccount' } });
        const refs = binding?.credentialBindings as { account?: Record<string, string> } | undefined;
        expect(refs?.account?.['api-key'], voiceCredentialGestureRecords().join('\n'))
            .toEqual(expect.stringMatching(/^happier:shared-secret:v1:/));
        expect(account!.settingsWrites).toHaveLength(1);
        expect(account!.purposes!.value).toEqual(purpose);
        expect(account!.purposes!.writes).toHaveLength(0);
        expect(account!.persistedSettings.secrets.some((secret) => secret.encryptedValue.value === 'fixture-new-dormant-key')).toBe(false);
    }, CASE_TIMEOUT_MS);

    it('recovers acknowledged Connect creation after its response is lost without replaying creation', async () => {
        const onChanged = vi.fn();
        await renderRow({ mode: 'plain', onChanged, initialRawSettings: { secrets: [], voiceSettingsV1: { credentialBindings: [] } } });
        account!.setLoseCreationResponse(true);
        await enterNewKey('original-uncertain-key');
        // The resource owner reconciles the accepted creation against the Home's
        // material before returning its reference; Connect does not replay it.
        await waitForCredentialChange();
        const resource = account!.resources[0];
        if (!resource || !('ref' in resource.entry)) throw new Error('Missing acknowledged created Resource');
        const resourceRef = resource.entry.ref;
        expect(onChanged).toHaveBeenCalledOnce();
        expect(account!.creations).toHaveLength(1);
        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({ credentialBindings: { account: { 'api-key': resourceRef } } });
    }, CASE_TIMEOUT_MS);

    it('writes the selected SavedSecret after a real Saved row click and explicit Use', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedKeys();

        // The picker is open and lists the account's stored records.
        const selectedRef = importedSecretRef(SECRETS[1]!.id);
        await selectSavedSecret(selectedRef);
        await waitForCredentialChange();
        expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull();

        // Asserting the call alone is what let three rounds of tests pass against
        // a feature that never worked: the contract is the CONTENT that reached
        // the account, and that the row now reports the record as in use.
        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': selectedRef } },
        });
        expect(credentialDetail()).toContain(t('settingsVoice.local.voiceCredential.setOnAccount'));
        expect(voiceCredentialGestureRecords()).toEqual([]);
    }, CASE_TIMEOUT_MS);

    it('imports a colon-bearing personal SavedSecret before binding its acknowledged Resource', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedKeys();

        await selectSavedSecret(importedSecretRef(SECRETS[0]!.id));
        await waitForCredentialChange();
        expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull();

        expect(appliedVoiceBinding()).toMatchObject({
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[0]!.id) } },
        });
    }, CASE_TIMEOUT_MS);

    it('repairs an orphaned Connected Account purpose binding through Connect without re-entering plaintext', async () => {
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
            connectedPurposes: { v: 1, bindings: [{
                purpose: { consumer: CONTRIBUTION, purpose: 'voice.client-auth' }, target: orphanedTarget,
            }] },
            initialRawSettings: {
                secrets: [SECRETS[1]!],
                voiceSettingsV1: { credentialBindings: [] },
            },
        });
        const savedRecordsBefore = account!.persistedSettings.secrets;

        await openSavedKeys();
        await selectSavedSecret(importedSecretRef(SECRETS[1]!.id));
        await waitForCredentialChange();
        expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull();

        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[1]!.id) } },
        });
        expect(account!.purposes!.value).toEqual({ v: 1, bindings: [] });
        expect(account!.persistedSettings.secrets).toEqual(savedRecordsBefore);
        expect(savedRecordsBefore).toEqual([]);
        expect(JSON.stringify(account!.settingsWrites)).not.toContain('fixture-live-key');
    }, CASE_TIMEOUT_MS);

    it('links the selected own secret without a second recipient-contract approval', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth', withRecipientContract: true });
        await openSavedKeys();
        await selectSavedSecret(importedSecretRef(SECRETS[1]!.id));
        await flush();

        await waitForCredentialChange();
        expect(query('web-modal-confirm')).toBeNull();
        expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull();

        expect(appliedVoiceBinding()).toMatchObject({
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[1]!.id) } },
        });
        expect(account!.settingsWrites).toHaveLength(1);
        expect(credentialDetail()).toContain(t('settingsVoice.local.voiceCredential.setOnAccount'));
        expect(appliedVoiceBinding()?.approvedRecipientContractDigest).toBeUndefined();
    }, CASE_TIMEOUT_MS);

    it('records one bounded failure when the Home refuses the settings compare-and-set', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        const before = account!.persistedSettings.voiceSettingsV1;
        account!.setRejectSettingsWrites(true);
        await openSavedKeys();
        await selectSavedSecret(importedSecretRef(SECRETS[1]!.id));
        await waitForCredentialFailure();
        expect(voiceCredentialGestureRecords()).toHaveLength(1);

        expect(account!.settingsWrites).toHaveLength(1);
        expect(account!.persistedSettings.voiceSettingsV1).toEqual(before);
        expect(appliedVoiceBinding()).toBeNull();
        expect(credentialDetail()).toContain(t('settingsVoice.local.voiceCredential.notSetOnAccount'));
        expect(voiceCredentialGestureRecords()).toHaveLength(1);
        expect(voiceCredentialGestureRecords()[0]).toContain('voice_credential_source_conflict');
        expect(voiceCredentialGestureRecords()[0]).toContain('"outcome":"failed"');
    }, CASE_TIMEOUT_MS);

    it('dismisses Connect without a selection, failure record or settings write', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedKeys();

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        await act(async () => {
            (document.activeElement ?? dialog!).dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true, cancelable: true,
            }));
        });
        await flush();

        expect(account!.settingsWrites).toHaveLength(0);
        expect(voiceCredentialGestureRecords()).toEqual([]);
    }, CASE_TIMEOUT_MS);
});
