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
 * console sink, the encryption-mode probe) are replaced.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Stands in for the account-settings transport only. It behaves the way the real
 * one does for a successful write — run the caller's reducer against the stored
 * raw and keep the result as the new stored state — so a test cannot pass by
 * reporting success over a write that produced nothing.
 */
const boundary = vi.hoisted(() => ({
    /** Set true to reproduce a transport that reports success and stores nothing. */
    reportAppliedWithoutApplying: false,
    appliedRaw: [] as Record<string, unknown>[],
    mutateAccountSettings: vi.fn(),
    mutateAccountSettingsOnce: vi.fn(),
    log: vi.fn<(message: string) => void>(),
    settings: null as Settings | null,
    rawSettings: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
}));

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

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: (props: React.PropsWithChildren<Record<string, unknown>>) => (
            React.createElement(React.Fragment, null, props.children)
        ),
    }),
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', null, props.children)
    ),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const React = await import('react');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const empty = settingsParse({});
    const readSettings = () => boundary.settings ?? empty;
    // The live account snapshot is a subscribed store: a settings write
    // re-renders every reader. A non-reactive stub would let the row keep
    // showing a stale label no matter what the write stored.
    const subscribe = (listener: () => void) => {
        boundary.listeners.add(listener);
        return () => { boundary.listeners.delete(listener); };
    };
    return {
        ...createStorageModuleStub({
            useSettings: () => React.useSyncExternalStore(subscribe, readSettings, readSettings),
        }),
        storage: { getState: () => ({ settings: readSettings() }) },
        getStorage: () => ({ getState: () => ({ settings: readSettings() }) }),
    };
});

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useSettingsVersion: () => 7,
    useSetting: (key: string) => (boundary.settings as unknown as Record<string, unknown> | null)?.[key],
    useLocalSetting: (key: string) => (key === 'uiFontScale' ? 1 : undefined),
}));

const syncSingleton = {
    getCredentials: () => ({ token: 'account-token' }),
    mutateAccountSettings: boundary.mutateAccountSettings,
    mutateAccountSettingsOnce: boundary.mutateAccountSettingsOnce,
};

vi.mock('@/sync/sync', () => ({ sync: syncSingleton }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => syncSingleton }));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' })),
}));

vi.mock('./VoiceRawCredentialAccessReview', () => ({
    VoiceRawCredentialAccessReview: () => null,
}));

// The menu trigger is not the defect under test (it is observed working in the
// running app); the picker it opens is. This stands in for the row's dropdown so
// the gesture can be started, and nothing downstream of it is replaced.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: {
        itemTrigger?: { title?: string; detailFormatter?: () => string };
        onSelect: (id: string) => void;
    }) => React.createElement(
        'button',
        {
            'data-testid': 'credential-gesture-menu',
            onClick: () => props.onSelect('useSavedSecret'),
        },
        React.createElement('span', { 'data-testid': 'credential-detail' },
            props.itemTrigger?.detailFormatter?.() ?? ''),
    ),
}));

vi.mock('@/voice/registry/defaultRegistry', () => ({
    createDefaultVoiceProviderRegistry: () => ({
        get: () => ({
            kind: 'voice.conversation-provider.v1',
            declaration: declarationRef.current,
        }),
    }),
}));

const declarationRef: { current: unknown } = { current: null };

const CONTRIBUTION = { pluginId: 'com.acme.voice', localId: 'conversation' } as const;

const SECRETS: SavedSecret[] = [
    {
        id: 'voice:realtime_elevenlabs:api_key',
        name: 'ElevenLabs (legacy slot id)',
        kind: 'apiKey',
        encryptedValue: {
            _isSecretValue: true,
            encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dC1sZWdhY3k=' },
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
            encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dC1saXZl' },
        },
        createdAt: 2,
        updatedAt: 2,
    },
];

let mounted: Readonly<{ root: Root; container: HTMLElement }> | null = null;

async function installAccountSettingsTransport(): Promise<void> {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const store = (next: Record<string, unknown>) => {
        boundary.appliedRaw.push(next);
        boundary.rawSettings = next;
        boundary.settings = settingsParse(next);
        for (const listener of [...boundary.listeners]) listener();
    };
    boundary.mutateAccountSettingsOnce.mockImplementation(async (input: {
        mutate: (raw: Record<string, unknown>) => { settings: Record<string, unknown>; value: unknown };
    }) => {
        // The reducer always runs — the real owner runs it before deciding
        // whether the outgoing state differs from the stored state — but a
        // "reports applied, stores nothing" run keeps the account unchanged.
        const produced = input.mutate(boundary.rawSettings);
        if (!boundary.reportAppliedWithoutApplying) store(produced.settings);
        return { status: 'applied' as const, settingsVersion: 8, value: produced.value };
    });
    boundary.mutateAccountSettings.mockImplementation(async (
        mutate: (raw: Record<string, unknown>) => Record<string, unknown>,
    ) => {
        const produced = mutate(boundary.rawSettings);
        if (!boundary.reportAppliedWithoutApplying) store(produced);
    });
}

afterEach(async () => {
    const current = mounted;
    mounted = null;
    if (current) {
        await act(async () => { current.root.unmount(); });
        current.container.remove();
    }
    boundary.reportAppliedWithoutApplying = false;
    boundary.appliedRaw = [];
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    boundary.log.mockClear();
});

function voiceCredentialGestureRecords(): string[] {
    return boundary.log.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('voice_credential:'));
}

function appliedVoiceBinding(): Record<string, unknown> | null {
    const last = boundary.appliedRaw[boundary.appliedRaw.length - 1];
    const voice = last?.voiceSettingsV1 as { credentialBindings?: unknown } | undefined;
    const bindings = Array.isArray(voice?.credentialBindings) ? voice.credentialBindings : [];
    return (bindings as Record<string, unknown>[]).find((binding) => (
        binding.credentialSlotId === 'api-key'
    )) ?? null;
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

async function renderRow(options: Readonly<{
    credentialSourcePurpose?: string;
    initialRawSettings?: Record<string, unknown>;
    multiSource?: boolean;
    withRecipientContract?: boolean;
}> = {}): Promise<void> {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { ModalProvider } = await import('@/modal');
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

    declarationRef.current = VoiceProviderContributionSchema.parse({
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
            modulePath: './voiceRuntime',
            exportName: 'activate',
        },
    });

    boundary.rawSettings = options.initialRawSettings ?? { secrets: SECRETS };
    boundary.settings = settingsParse(boundary.rawSettings);
    await installAccountSettingsTransport();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
        root.render(
            <ModalProvider>
                <VoiceCredentialItem
                    testID="voice-credential"
                    title="ElevenLabs API Key"
                    promptTitle="ElevenLabs API Key"
                    promptDescription="Paste the key"
                    contribution={CONTRIBUTION}
                    credentialSlotId="api-key"
                    credentialSourcePurpose={options.credentialSourcePurpose}
                    credentialSourceDeclaration={declarationRef.current as never}
                    recipientContract={recipientContract}
                    recipientContractDigest={recipientContract
                        ? createRecipientContractDigestV1(recipientContract)
                        : null}
                    disclosePlainStorage={false}
                />
            </ModalProvider>,
        );
    });
}

/**
 * The first render pulls in the modal host, the protocol package and the Voice
 * registry. Warmed once so a single test is not charged for the whole graph.
 */
beforeAll(async () => {
    await Promise.all([
        import('@/modal'),
        import('./CredentialItem'),
        import('@happier-dev/protocol'),
        import('@/sync/domains/settings/settings'),
    ]);
}, 180_000);

const CASE_TIMEOUT_MS = 180_000;

describe('Voice credential row → saved-secret picker → account-settings write', () => {
    it('writes the selected SavedSecret when a real click lands on a picker row', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();

        // The picker is open and lists the account's stored records.
        const row = requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666');

        await act(async () => { pressWithPointer(row); });
        await flush();

        // Asserting the call alone is what let three rounds of tests pass against
        // a feature that never worked: the contract is the CONTENT that reached
        // the account, and that the row now reports the record as in use.
        expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledTimes(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
        });
        expect(requireNode('credential-detail').textContent)
            .toBe('settingsVoice.local.voiceCredential.setOnAccount');
        expect(voiceCredentialGestureRecords()).toEqual([]);
    }, CASE_TIMEOUT_MS);

    it('writes a colon-bearing SavedSecret id unchanged', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();

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

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledTimes(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
        });
        expect(boundary.rawSettings.connectedAccountPurposeBindingsV1).toEqual({
            v: 1,
            bindings: [],
        });
        expect(boundary.rawSettings.secrets).toEqual([SECRETS[1]]);
        expect(JSON.stringify(boundary.rawSettings)).not.toContain('sk-');
    }, CASE_TIMEOUT_MS);

    it('reaches the write through the recipient-contract approval the live slot requires', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth', withRecipientContract: true });

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        const confirm = query('web-modal-confirm');
        expect(confirm, 'the recipient approval must still be readable after the picker closes').not.toBeNull();
        await act(async () => { pressWithPointer(confirm!); });
        await flush();

        expect(appliedVoiceBinding()).toMatchObject({
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': '2cd702f5-1111-4222-8333-444455556666' } },
        });
        expect(requireNode('credential-detail').textContent)
            .toBe('settingsVoice.local.voiceCredential.setOnAccount');
    }, CASE_TIMEOUT_MS);

    /**
     * The live failure mode this whole corridor kept missing: the account-settings
     * owner reports the mutation as applied while the stored state never gains the
     * binding (an outgoing state equal to the stored state is applied WITHOUT a
     * request). Every earlier test stopped at "the boundary was called", so this
     * one is indistinguishable from success for them.
     */
    it('records one bounded failure when the write reports success but binds nothing', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        boundary.reportAppliedWithoutApplying = true;

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();
        await act(async () => {
            pressWithPointer(requireNode('saved-secret:2cd702f5-1111-4222-8333-444455556666'));
        });
        await flush();

        expect(requireNode('credential-detail').textContent)
            .toBe('settingsVoice.local.voiceCredential.notSetOnAccount');
        expect(voiceCredentialGestureRecords()).toHaveLength(1);
        expect(voiceCredentialGestureRecords()[0]).toContain('saved_secret_binding_not_effective');
        expect(voiceCredentialGestureRecords()[0]).toContain('"outcome":"unapplied"');
    }, CASE_TIMEOUT_MS);

    /**
     * A press the picker never delivers and a deliberate cancel close the surface
     * identically. Without a record the two are the same observation — which is
     * exactly why four live sessions could not tell them apart.
     */
    it('records one bounded failure when the picker closes without a selection', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });

        await act(async () => { pressWithPointer(requireNode('credential-gesture-menu')); });
        await flush();

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        await act(async () => {
            dialog!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
        await flush();

        expect(boundary.mutateAccountSettingsOnce).not.toHaveBeenCalled();
        expect(voiceCredentialGestureRecords()).toHaveLength(1);
        expect(voiceCredentialGestureRecords()[0]).toContain('saved_secret_selection_dismissed');
    }, CASE_TIMEOUT_MS);
});
