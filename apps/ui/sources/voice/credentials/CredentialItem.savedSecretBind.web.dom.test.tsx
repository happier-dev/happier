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
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedPurposeCatalogV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol';
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

function importedSecretRef(personalId: string): string {
    const source = SECRETS.find(secret => secret.id === personalId);
    const resource = account?.resources.find(material => material.entry.name === source?.name);
    if (!resource) throw new Error(`Missing acknowledged fixture Resource for ${personalId}`);
    return resource.entry.ref;
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
    await vi.waitFor(() => expect(requireNode('voice-credential').querySelector<HTMLElement>('[tabindex="0"],[role="button"],button')).not.toBeNull());
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
    mode?: 'plain' | 'e2ee';
    connectedPurposes?: ConnectedPurposeCatalogV1;
    credentialSourcePurpose?: string;
    initialRawSettings?: Record<string, unknown>;
    multiSource?: boolean;
    withRecipientContract?: boolean;
    approvalRequired?: boolean;
    onChanged?: () => void;
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

    // The boundary's full personal-promotion transaction is Plain. E2EE
    // material admission is exercised by the canonical resource-owner suites.
    account = await createSecretSettingsTestHarness({ mode: options.mode ?? 'plain', approvalRequired: options.approvalRequired });
    const purposesPath = '/v1/account/entity-rows/connected-accounts/purposes';
    let purposes = options.connectedPurposes ?? { v: 1 as const, bindings: [] };
    let purposeRevision = 9;
    account.catalogRows.set(purposesPath, {
        status: 'present', revision: purposeRevision, content: { t: 'plain', v: { key: 'purposes', value: purposes } },
    });
    // The real source owner commits the purpose row and Settings atomically;
    // extend only this HTTP boundary, retaining its actual DTO and Settings CAS.
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/auth/ping') return Response.json({});
        if (path !== purposesPath || init?.method !== 'POST') return account!.request(url, init);
        const input = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        if (input.expectedRevision !== purposeRevision) return Response.json({ status: 'conflict', revision: purposeRevision });
        if (input.content?.t !== 'plain' || input.content.v.key !== 'purposes') throw new Error('Expected Plain purpose row');
        let settingsVersion: number | undefined;
        if (input.settingsMutation) {
            const response = await account!.request(new URL('/v2/account/settings', String(url)), {
                method: 'POST', body: JSON.stringify({ expectedVersion: input.settingsMutation.expectedSettingsVersion,
                    content: input.settingsMutation.content }),
            });
            const receipt = AccountSettingsV2UpdateResponseSchema.parse(await response.json());
            if (!receipt.success) return Response.json({ status: 'settings-conflict', revision: receipt.currentVersion });
            settingsVersion = receipt.version;
        }
        purposes = ConnectedPurposeCatalogV1Schema.parse(input.content.v.value);
        purposeRevision += 1;
        account!.catalogRows.set(purposesPath, { status: 'present', revision: purposeRevision, content: input.content });
        return Response.json({ status: 'updated', revision: purposeRevision, cursor: purposeRevision,
            ...(settingsVersion === undefined ? {} : { settingsVersion }) });
    });
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
    const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    await refreshSavedSecretCatalog(account.scope);
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
                        onChanged={options.onChanged}
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
        const row = requireNode('voice-credential');
        const trigger = row.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
        await act(async () => { pressWithPointer(trigger ?? row); });
        if (trigger) {
            await vi.waitFor(() => expect(query('dropdown-option-enterNew')).not.toBeNull());
            await act(async () => { pressWithPointer(requireNode('dropdown-option-enterNew')); });
        }
        await vi.waitFor(() => expect(query('web-prompt-input')).not.toBeNull());
        const input = requireNode('web-prompt-input') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixture-new-dormant-key');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { pressWithPointer(requireNode('web-prompt-confirm')); });
        if (approvalRequired) {
            await vi.waitFor(() => expect(account!.artifacts.list()).toHaveLength(1));
            await flush();
            expect(voiceCredentialGestureRecords()).toEqual([]);
            expect(account!.promotions).toHaveLength(0);
            expect(account!.settingsWrites).toHaveLength(0);
            expect(appliedVoiceBinding()).toMatchObject({ credentialSource: { kind: 'connectedAccount' }, credentialBindings: { account: {} } });
            await act(async () => { pressWithPointer(requireNode('voice-credential')); });
            await flush();
            expect(query('web-prompt-input')).toBeNull();
            expect(account!.artifacts.list()).toHaveLength(1);
            const { StoredApprovalRequestSchema, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent } = await import('@happier-dev/protocol');
            const { SharedSavedSecretPromoteInputV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretResourceActionsV1');
            const artifact = account!.artifacts.list()[0]!;
            const request = StoredApprovalRequestSchema.parse(JSON.parse(account!.artifacts.readPlainBody(artifact.id)!));
            if (request.v !== 2) throw new Error('Expected the original result-bearing approval');
            const originalInput = SharedSavedSecretPromoteInputV1Schema.parse(request.actionArgs);
            const settledAt = request.createdAtMs + 1;
            // Only the server transport is synthetic. Execute the exact sealed
            // operand accepted by Ask, then deliver its durable Artifact result.
            const result = approval === 'executed'
                ? await (await account!.request('https://approval-boundary.test/v1/account/saved-secrets/resources/promote', {
                    method: 'POST', body: JSON.stringify(originalInput),
                })).json() as unknown
                : null;
            const settled = StoredApprovalRequestSchema.parse(approval === 'canceled'
                ? { ...request, status: 'canceled', updatedAtMs: settledAt }
                : { ...request, status: 'executed', updatedAtMs: settledAt,
                    decision: { kind: 'approve', decidedAtMs: settledAt },
                    execution: { ok: true, executedAtMs: settledAt, result } });
            const response = await account!.artifacts.handle(`/v1/artifacts/${artifact.id}`, {
                method: 'POST', body: JSON.stringify({
                    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(settled)), expectedHeaderVersion: artifact.headerVersion,
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(settled) }), expectedBodyVersion: artifact.bodyVersion,
                }),
            });
            expect(await response?.json()).toMatchObject({ success: true });
            const persistedArtifact = account!.artifacts.read(artifact.id);
            if (!persistedArtifact) throw new Error('Expected the acknowledged terminal Artifact');
            const { storage } = await import('@/sync/domains/state/storage');
            await act(async () => { storage.getState().updateArtifact({ id: artifact.id,
                header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled), title: null,
                headerVersion: persistedArtifact.headerVersion, bodyVersion: persistedArtifact.bodyVersion,
                seq: persistedArtifact.seq, createdAt: persistedArtifact.createdAt, updatedAt: persistedArtifact.updatedAt, isDecrypted: true }); });
            if (approval === 'canceled') {
                await vi.waitFor(() => expect(voiceCredentialGestureRecords().length).toBeGreaterThan(0));
                expect(account!.promotions).toHaveLength(0);
                expect(onChanged).not.toHaveBeenCalled();
                expect(appliedVoiceBinding()).toMatchObject({ credentialSource: { kind: 'connectedAccount' }, credentialBindings: { account: {} } });
                return;
            }
            await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
            expect(account!.promotions).toHaveLength(1);
            expect(account!.promotions[0]!.resourceId).toBe(originalInput.resourceId);
        }
        await vi.waitFor(() => {
            const binding = appliedVoiceBinding();
            expect(binding).toMatchObject({ credentialSource: { kind: 'connectedAccount' } });
            const refs = binding?.credentialBindings as { account?: Record<string, string> } | undefined;
            expect(refs?.account?.['api-key'], voiceCredentialGestureRecords().join('\n'))
                .toEqual(expect.stringMatching(/^happier:shared-secret:v1:/));
        }, { timeout: CASE_TIMEOUT_MS });
        expect(account!.settingsWrites).toHaveLength(0);
        expect(account!.catalogRows.get('/v1/account/entity-rows/connected-accounts/purposes'))
            .toMatchObject({ revision: 9, content: { v: { value: purpose } } });
        expect(account!.persistedSettings.secrets.some((secret) => secret.encryptedValue.value === 'fixture-new-dormant-key')).toBe(false);
    }, CASE_TIMEOUT_MS);

    it.each([false, true])('verifies the original uncertain new-credential gesture before offering another credential (temporarily unavailable: %s)', async temporarilyUnavailable => {
        const onChanged = vi.fn();
        await renderRow({ mode: 'plain', onChanged, initialRawSettings: { secrets: [], voiceSettingsV1: { credentialBindings: [] } } });
        account!.setLosePromotionResponse(true);
        await act(async () => { pressWithPointer(requireNode('voice-credential')); });
        await vi.waitFor(() => expect(query('web-prompt-input')).not.toBeNull());
        const input = requireNode('web-prompt-input') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'original-uncertain-key');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { pressWithPointer(requireNode('web-prompt-confirm')); });
        await vi.waitFor(() => expect(account!.promotions).toHaveLength(1));
        await vi.waitFor(() => expect(voiceCredentialGestureRecords().length).toBeGreaterThan(0));
        // Dismiss the existing outcome alert, not the owning credential row.
        await vi.waitFor(() => expect(query('web-modal-button-0')).not.toBeNull());
        await act(async () => { pressWithPointer(requireNode('web-modal-button-0')); });
        await flush();
        const originalId = account!.promotions[0]!.resourceId;
        const originalResources = [...account!.resources];
        if (temporarilyUnavailable) account!.resources.splice(0);
        const row = requireNode('voice-credential');
        const trigger = row.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
        await act(async () => { pressWithPointer(trigger ?? row); });
        if (trigger) {
            await vi.waitFor(() => expect(query('dropdown-option-enterNew')).not.toBeNull());
            await act(async () => { pressWithPointer(requireNode('dropdown-option-enterNew')); });
        }
        if (temporarilyUnavailable) {
            await vi.waitFor(() => expect(Boolean(query('web-modal-button-0') ?? query('web-prompt-input'))).toBe(true));
            expect(onChanged).not.toHaveBeenCalled();
            expect(query('web-prompt-input')).toBeNull();
            expect(query('web-modal-button-0')).not.toBeNull();
            expect(account!.promotions).toHaveLength(1);
            await act(async () => { pressWithPointer(requireNode('web-modal-button-0')); });
            // The canonical materials endpoint again observes the exact accepted
            // resource. Recovery still verifies the original sealed intent.
            account!.resources.push(...originalResources);
            await flush();
            const nextRow = requireNode('voice-credential');
            const nextTrigger = nextRow.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
            await act(async () => { pressWithPointer(nextTrigger ?? nextRow); });
            if (nextTrigger) {
                await vi.waitFor(() => expect(query('dropdown-option-enterNew')).not.toBeNull());
                await act(async () => { pressWithPointer(requireNode('dropdown-option-enterNew')); });
            }
        }
        await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
        expect(query('web-prompt-input')).toBeNull();
        expect(account!.promotions).toHaveLength(1);
        expect(account!.resources.map(resource => 'resourceId' in resource ? resource.resourceId : null)).toEqual([originalId]);
        expect(account!.settingsWrites).toHaveLength(0);
    }, CASE_TIMEOUT_MS);

    it('writes the selected SavedSecret when a real click lands on a picker row', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedSecretPicker();

        // The picker is open and lists the account's stored records.
        const selectedRef = importedSecretRef(SECRETS[1]!.id);
        const row = requireNode(`saved-secret:${selectedRef}`);

        await act(async () => { pressWithPointer(row); });
        await vi.waitFor(() => expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull());

        // Asserting the call alone is what let three rounds of tests pass against
        // a feature that never worked: the contract is the CONTENT that reached
        // the account, and that the row now reports the record as in use.
        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': selectedRef } },
        });
        expect(credentialDetail()).toContain('settingsVoice.local.voiceCredential.setOnAccount');
        expect(voiceCredentialGestureRecords()).toEqual([]);
    }, CASE_TIMEOUT_MS);

    it('imports a colon-bearing personal SavedSecret before binding its acknowledged Resource', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        await openSavedSecretPicker();

        await act(async () => {
            pressWithPointer(requireNode(`saved-secret:${importedSecretRef(SECRETS[0]!.id)}`));
        });
        await vi.waitFor(() => expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull());

        expect(appliedVoiceBinding()).toMatchObject({
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[0]!.id) } },
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
            connectedPurposes: { v: 1, bindings: [{
                purpose: { consumer: CONTRIBUTION, purpose: 'voice.client-auth' }, target: orphanedTarget,
            }] },
            initialRawSettings: {
                secrets: [SECRETS[1]!],
                voiceSettingsV1: { credentialBindings: [] },
            },
        });
        const savedRecordsBefore = account!.persistedSettings.secrets;

        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode(`saved-secret:${importedSecretRef(SECRETS[1]!.id)}`));
        });
        await vi.waitFor(() => expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull());

        expect(account!.settingsWrites).toHaveLength(1);
        expect(appliedVoiceBinding()).toMatchObject({
            credentialSlotId: 'api-key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[1]!.id) } },
        });
        expect(account!.catalogRows.get('/v1/account/entity-rows/connected-accounts/purposes')).toMatchObject({
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
        });
        expect(account!.persistedSettings.secrets).toEqual(savedRecordsBefore);
        expect(savedRecordsBefore).toEqual([]);
        expect(JSON.stringify(account!.settingsWrites)).not.toContain('fixture-live-key');
    }, CASE_TIMEOUT_MS);

    it('reaches the write through the recipient-contract approval the live slot requires', async () => {
        const approvedDigest = await renderRow({ credentialSourcePurpose: 'voice.client-auth', withRecipientContract: true });
        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode(`saved-secret:${importedSecretRef(SECRETS[1]!.id)}`));
        });
        await flush();

        const confirm = query('web-modal-confirm');
        expect(confirm, 'the recipient approval must still be readable after the picker closes').not.toBeNull();
        expect(account!.settingsWrites).toHaveLength(0);
        expect(appliedVoiceBinding()).toBeNull();
        await act(async () => { pressWithPointer(confirm!); });
        await vi.waitFor(() => expect(appliedVoiceBinding(), JSON.stringify(voiceCredentialGestureRecords())).not.toBeNull());

        expect(appliedVoiceBinding()).toMatchObject({
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { 'api-key': importedSecretRef(SECRETS[1]!.id) } },
            approvedRecipientContractDigest: expect.stringMatching(/^sha256:/),
        });
        expect(account!.settingsWrites).toHaveLength(1);
        expect(credentialDetail()).toContain('settingsVoice.local.voiceCredential.setOnAccount');
        expect(appliedVoiceBinding()?.approvedRecipientContractDigest).not.toBe(approvedDigest);
    }, CASE_TIMEOUT_MS);

    it('records one bounded failure when the Home refuses the settings compare-and-set', async () => {
        await renderRow({ credentialSourcePurpose: 'voice.client-auth' });
        const before = account!.persistedSettings.voiceSettingsV1;
        account!.setRejectSettingsWrites(true);
        await openSavedSecretPicker();
        await act(async () => {
            pressWithPointer(requireNode(`saved-secret:${importedSecretRef(SECRETS[1]!.id)}`));
        });
        await vi.waitFor(() => expect(voiceCredentialGestureRecords()).toHaveLength(1));

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
