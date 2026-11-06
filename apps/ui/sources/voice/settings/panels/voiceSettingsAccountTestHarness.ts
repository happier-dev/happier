import { vi } from 'vitest';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import { formatSavedSecretCatalogFingerprintV1, formatSavedSecretCatalogReferenceV1, SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';

export type VoiceSettingsAccountTestHarness = Omit<
    Awaited<ReturnType<typeof createSecretSettingsTestHarness>>, 'purposes'
> & {
    purposes: NonNullable<Awaited<ReturnType<typeof createSecretSettingsTestHarness>>['purposes']>;
    writes: unknown[];
    readonly settings: Settings;
    readonly persistedSettings: Settings;
    kv: ReturnType<typeof createAccountKvHttpFixture>;
    replaceConnectedPurposes(next: ConnectedPurposeCatalogV1): Promise<void>;
    replaceVoice(next: VoiceSettings): void;
};

/** Real Account Settings owner; only the Home HTTP transport is synthetic. */
export async function createVoiceSettingsAccountTestHarness(settings: Settings,
    options: Pick<NonNullable<Parameters<typeof createSecretSettingsTestHarness>[0]>, 'accountId' | 'features' | 'token' | 'serverIdentityId' | 'mode' | 'rawSettings'> = {}): Promise<VoiceSettingsAccountTestHarness> {
    const account = await createSecretSettingsTestHarness({ ...options, settings, voiceEnabled: true, connectedPurposes: { v: 1, bindings: [] } });
    const request = account.request.getMockImplementation();
    if (!request) throw new Error('Voice Settings Account HTTP boundary missing');
    const kv = createAccountKvHttpFixture();
    // Saved Secret maintenance reads every current reference-owning catalog.
    // These Voice fixtures have no external Prompt Registry credentials.
    account.request.mockImplementation(async (input, init) => await kv.handleFetch(input, init) ?? (new URL(String(input)).pathname
        === '/v1/account/entity-rows/prompt-library/registry-sources'
        ? Response.json({ status: 'absent' }) : request(input, init)));
    const { replaceSettings } = account;
    await account.purposes!.hydrate(account.scope);
    return {
        ...account,
        kv,
        purposes: account.purposes!,
        writes: account.settingsWrites,
        get settings() { return storage.getState().settings; },
        get persistedSettings() { return account.persistedSettings; },
        async replaceConnectedPurposes(next: ConnectedPurposeCatalogV1) {
            account.purposes!.replace(next);
            await account.purposes!.hydrate(account.scope);
        },
        replaceSettings,
        replaceVoice(next: VoiceSettings) {
            const current = storage.getState().settings;
            // A server-side fixture edit advances its revision just like a real
            // Settings write. An older in-flight bootstrap read cannot erase it.
            replaceSettings(settingsParse({ ...current, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current) }), {
                version: (storage.getState().settingsVersion ?? 0) + 1,
            });
        },
    };
}

/** Current credential material at the Home HTTP boundary, bound by the real source owner.
 * Legacy Settings import has a separate approval/lifecycle contract. */
export async function withVoiceSettingsCredentialResource(account: VoiceSettingsAccountTestHarness, params: Readonly<{
    settings: Settings;
    declaration: VoiceProviderContribution;
    pluginId: string;
    resourceId: string;
    machineId?: string;
    recipientContractDigest?: string;
    approvedRecipientContractDigest?: string;
}>): Promise<Settings> {
    const { applyAccountVoiceCredentialSourceSelection, createAccountVoiceCredentialBindingMutation,
        resolveAccountVoiceCredentialApprovalDigest, resolveExactAccountVoiceCredentialSecretId } = await import('@/voice/credentials/accountVoiceCredential');
    const slot = params.declaration.credentials?.slot;
    if (!slot) throw new Error('Expected a Voice credential slot');
    const expectedSettingsVersion = storage.getState().settingsVersion;
    if (expectedSettingsVersion === null) throw new Error('Expected hydrated Voice Account Settings');
    const contribution = { pluginId: params.pluginId, localId: params.declaration.id };
    const expectedSecretId = resolveExactAccountVoiceCredentialSecretId({ settings: params.settings,
        contribution, credentialSlotId: slot.id, machineId: params.machineId });
    const existing = params.settings.secrets.find(secret => secret.id === expectedSecretId);
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: params.resourceId });
    const content = { v: 1 as const, name: params.resourceId, kind: 'apiKey' as const, value: `${params.resourceId}-key` };
    account.resources.push(SavedSecretResourceMaterialV1Schema.parse({
        resourceId: params.resourceId, encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: params.resourceId, mode: 'plain', content }),
        entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: account.scope.accountId,
            name: content.name, kind: content.kind, encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    }));
    const approvedRecipientContractDigest = params.approvedRecipientContractDigest
        ?? resolveAccountVoiceCredentialApprovalDigest({ requiredRecipientContractDigest: params.recipientContractDigest,
            savedSecret: { kind: 'shared_resource', fingerprint: formatSavedSecretCatalogFingerprintV1({
                ref, source: 'shared_resource', revision: 1,
            }) } });
    return applyAccountVoiceCredentialSourceSelection({
        settings: params.settings, connectedPurposes: account.purposes.value, currentDeclaration: params.declaration,
        mutation: { contribution, credentialSlotId: slot.id, expectedSettingsVersion,
            selection: { kind: 'savedSecret' }, savedSecretMutation: createAccountVoiceCredentialBindingMutation({
                contribution, credentialSlotId: slot.id, machineId: params.machineId, secretId: ref,
                expectedSecretId, expectedSecretUpdatedAt: existing?.updatedAt ?? null,
                ...(approvedRecipientContractDigest ? { approvedRecipientContractDigest } : {}),
            }) },
    }).settings;
}

/** Real activation, Account credential admission, tools and human interactions;
 * only the vendor HTTPS transport is synthetic. */
export function createElevenLabsSettingsRuntimeTestHarness() {
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find((candidate) => candidate.declaration.id === 'realtime-elevenlabs');
    if (!entry) throw new Error('ElevenLabs runtime entry missing');
    const recipientContract = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
    if (!recipientContract) throw new Error('ElevenLabs recipient contract missing');
    const hostLease = createBundledConversationRuntimeHostLease();
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    let nextOccurrence = 0;
    let nextToolId = 0;
    let createdAgentConfig: Readonly<Record<string, unknown>> | null = null;
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
    });
    const fetch = vi.fn<RuntimeFetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== 'https://api.elevenlabs.io' || init?.redirect !== 'manual'
            || !new Headers(init.headers).get('xi-api-key')) throw new Error('Unexpected vendor HTTP authority');
        const method = init.method ?? 'GET';
        if (method === 'GET' && url.pathname === '/v1/convai/agents') return response({ agents: [], has_more: false, next_cursor: null });
        if (method === 'GET' && url.pathname === '/v1/voices') return response({ voices: [{ voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Happier voice', category: 'premade' }] });
        if (method === 'GET' && url.pathname === '/v1/convai/tools') return response({ tools: [], has_more: false, next_cursor: null });
        if (method === 'POST' && url.pathname === '/v1/convai/tools') return response({ id: `tool_${++nextToolId}` });
        if (method === 'POST' && url.pathname === '/v1/convai/agents/create') {
            const body: unknown = JSON.parse(await new Response(init.body).text());
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected authored ElevenLabs Agent body');
            // The HTTP fixture retains the provider-authored JSON object, not a second config owner.
            createdAgentConfig = body as Readonly<Record<string, unknown>>;
            return response({ agent_id: 'agent_created' });
        }
        if (method === 'GET' && /^\/v1\/convai\/agents\/[^/]+$/.test(url.pathname)) {
            if (!createdAgentConfig) throw new Error('Expected an Agent created through the HTTP fixture');
            return response({ ...createdAgentConfig, agent_id: url.pathname.slice('/v1/convai/agents/'.length) });
        }
        throw new Error(`Unexpected vendor HTTP request: ${method} ${url.pathname}`);
    });
    return {
        fetch, response, entry,
        get registration() {
            const registration = getExternalVoiceProviderRegistration(entry.providerId);
            if (!registration) throw new Error('ElevenLabs runtime has not been registered');
            return registration;
        },
        async register() {
            const next = createExternalVoiceProviderActivationScope({
                pluginId: entry.pluginId, occurrenceId: `voice-settings-test-occurrence-${++nextOccurrence}`,
                declarations: [entry.declaration], hostPlatform: 'web',
                hostBindingsByLocalId: { [entry.declaration.id]: {
                    descriptor: 'bundled', recipientContract,
                    createInvocationAccountOperations: (signal, _sessionId, isCurrent, phase) => createAccountVoiceOperationService({
                        providerId: entry.providerId,
                        contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
                        declaration: entry.declaration, phase, recipientContract, signal, isCurrent, fetch,
                    }),
                } },
            });
            const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
            (await loadBundledVoiceRuntimeActivate(entry))(next.api);
            await next.commit();
            const previous = scope;
            scope = next;
            await previous?.unwind();
        },
        async dispose() { await scope?.unwind(); hostLease.revoke(); },
    };
}
