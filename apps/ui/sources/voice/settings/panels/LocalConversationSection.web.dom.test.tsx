/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForTestEvent } from '@/dev/testkit';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness,
    createProviderSettingsHarness, installProviderSettingsRpcBoundary, installBundledProviderDeclarationsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import {
    tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const transport = vi.hoisted(() => ({ projection: null as unknown, projectionReads: [] as unknown[] }));
const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
// Only Socket delivery is replaced; routing, Action admission and receipt arbitration stay real.
beforeEach(() => {
    installBundledProviderDeclarationsRpcBoundary(daemon);
    daemon.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async request => {
        transport.projectionReads.push(request.payload);
        return transport.projection;
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// The mounted editor is focused; navigation delivery is a platform boundary.
vi.mock('@react-navigation/native', async () => ({
    ...await vi.importActual<Record<string, unknown>>('@react-navigation/native'),
    useIsFocused: () => true,
}));
vi.mock('react-native', async () => {
    const actual: Record<string, unknown> = await vi.importActual('react-native-web');
    return { ...actual, Platform: { ...(actual.Platform as object), OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default ?? values.native } };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren) => React.createElement('div', null, props.children),
}));
// The native crypto SDK is unavailable in JSDOM; Protocol codecs stay real.
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

const account = createProviderSettingsAccountHarness();
let mounted: { root: Root; container: HTMLElement } | null = null;
let locks: ReturnType<typeof installWebLockManagerMock> | undefined;
afterEach(async () => {
    if (mounted) {
        await act(async () => mounted?.root.unmount());
        mounted.container.remove();
        mounted = null;
    }
    await account.reset();
    locks?.restore();
    locks = undefined;
    transport.projectionReads.length = 0;
    daemon.reset();
});

function press(node: HTMLElement) {
    const event = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
    node.dispatchEvent(new MouseEvent('mousedown', { ...event, buttons: 1 }));
    node.dispatchEvent(new MouseEvent('mouseup', { ...event, buttons: 0 }));
    node.dispatchEvent(new MouseEvent('click', { ...event, buttons: 0 }));
}

function subscribeDom(notify: () => void) {
    const observer = new MutationObserver(notify);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => observer.disconnect();
}

function subscribeHomeOrDom(notify: () => void) {
    const stopHome = account.home.subscribe(notify);
    const stopDom = subscribeDom(notify);
    return () => { stopHome(); stopDom(); };
}

async function waitForSaveError() {
    await waitForTestEvent(subscribeDom, () => document.body.textContent,
        text => text?.includes(t('common.saveError')) === true);
    expect(document.body.textContent).toContain(t('common.saveError'));
}

describe('imported Voice Chat Agent selection through the real settings gesture', () => {
    it.each(['owner-action', 'owner-agent-action', 'owner-agent-conditional', 'acknowledged', 'provider-conflict', 'settings-conflict', 'owner-receipt', 'owner-same-model', 'owner-unknown-ack', 'owner-existing-resource', 'owner-existing-resource-unrelated', 'existing-resource',
        'personal-approval-executed', 'personal-approval-canceled', 'personal-approval-unmounted'] as const)(
      'keeps the genuine predecessor selection until the imported Provider row is acknowledged (%s)', async outcome => {
        locks = installWebLockManagerMock();
        const usesResource = outcome === 'existing-resource' || outcome === 'owner-existing-resource' || outcome === 'owner-existing-resource-unrelated';
        const usesPersonalApproval = outcome === 'personal-approval-executed' || outcome === 'personal-approval-canceled'
            || outcome === 'personal-approval-unmounted';
        const resourceId = '2cd702f5-1111-4222-8333-444455556666';
        const resourceRef = formatSharedSavedSecretRefV1(resourceId);
        const original = { experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true },
            ...(usesPersonalApproval ? { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'secrets.shared.promote': { approvalRequiredSurfaces: ['ui'] } },
        }) } : {}), secrets: outcome === 'owner-existing-resource-unrelated' ? [{
            id: 'unrelated-personal', name: 'Unrelated token', kind: 'token', createdAt: 1, updatedAt: 1,
            encryptedValue: { _isSecretValue: true, value: 'unrelated-personal-value' },
        }] : [], voice: { providerId: 'local_conversation',
            ...(usesResource ? { credentialBindings: [{ providerId: 'openai_compat',
                credentialBindings: { account: { chat_api_key: resourceRef } } }] } : {}),
            adapters: { local_conversation: {
            conversationMode: 'agent', agent: { backend: 'openai_compat', agentSource: 'agent', agentId: 'opencode',
                openaiCompat: { chatBaseUrl: 'https://legacy-chat.test/v1',
                    chatApiKey: usesResource || usesPersonalApproval ? { _isSecretValue: true, value: 'owned-chat-value' } : null,
                    chatModel: 'legacy-chat', commitModel: outcome === 'owner-same-model' ? 'legacy-chat' : 'legacy-commit', temperature: 0.4, maxTokens: 2048 },
            },
        } } } };
        const features = createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, voice: { enabled: true } } });
        if (usesPersonalApproval) {
            expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
            expect(tryWriteServerEnabledBitInPlace(features, 'encryption.plaintextStorage', true)).toBe(true);
        }
        const scope = await account.restore({ settings: original, features,
            machines: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })],
        });
        if (outcome === 'owner-existing-resource-unrelated') account.home.answer(scope.serverId, PROFILE_ROWS_ROUTE_V1, {
            status: 503, body: { error: 'unavailable' },
        });
        if (usesPersonalApproval) {
            account.home.answer(scope.serverId, PROFILE_ROWS_ROUTE_V1, { body: { status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] } });
            account.home.answer(scope.serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 3 } });
            for (const route of [PROFILE_TRANSFER_ROUTE_V1, REMOTE_HOST_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1,
                '/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp',
                '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes',
                '/v1/account/entity-rows/prompt-library/registry-sources']) {
                account.home.answer(scope.serverId, route, { body: { status: 'absent' } });
            }
            account.home.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
        }
        if (usesResource) {
            const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId, encryptionMode: 'plain',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
                    v: 1, name: 'Retained Chat key', kind: 'apiKey', value: 'owned-chat-value',
                } }), recipientEnvelope: null, entry: { ref: resourceRef, source: 'shared_resource', relationship: 'owner',
                    ownerAccountId: scope.accountId, name: 'Retained Chat key', kind: 'apiKey', encryptionMode: 'plain',
                    revision: 3, materialStatus: 'ready', capabilities: {
                        use: true, rename: true, rotate: true, manageAccess: true, delete: true,
                    } },
            });
            account.home.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [resource] } });
            account.home.answer(scope.serverId, '/v1/account/saved-secrets/resources', { body: { resources: [resource.entry] } });
        }
        let stored: Readonly<Record<string, unknown>> = original;
        let settingsVersion = 1;
        account.home.answer(scope.serverId, 'POST /v2/account/settings', { select: input => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== settingsVersion || request.content?.t !== 'plain') return { status: 409, body: {
                success: false, error: 'version-mismatch', currentVersion: settingsVersion, currentContent: { t: 'plain', v: stored },
            } };
            stored = request.content.v;
            settingsVersion += 1;
            account.home.answer(scope.serverId, '/v2/account/settings', { body: { content: request.content, version: settingsVersion } });
            return { body: { success: true, version: settingsVersion } };
        } });
        let acknowledge!: () => void;
        const ack = new Promise<void>(resolve => { acknowledge = resolve; });
        let providerWrites = 0;
        let importedModelSettings: unknown;
        let approvedResourceId: string | undefined;
        if (usesPersonalApproval) account.home.answer(scope.serverId, 'POST /v1/account/saved-secrets/resources/promote', {
            select: raw => {
                const input = SharedSavedSecretPromoteInputV1Schema.parse(raw);
                expect(input.expectedSettingsVersion).toBe(settingsVersion);
                if (input.nextSettings?.t !== 'plain') throw new Error('Expected the captured Plain source');
                approvedResourceId = input.resourceId;
                stored = input.nextSettings.v;
                settingsVersion += 1;
                account.home.answer(scope.serverId, '/v2/account/settings', { body: { content: input.nextSettings, version: settingsVersion } });
                const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId: input.resourceId, encryptionMode: 'plain',
                        storedContent: input.storedContent, recipientEnvelope: null, entry: {
                            ref: formatSharedSavedSecretRefV1(input.resourceId), source: 'shared_resource', relationship: 'owner',
                            ownerAccountId: scope.accountId, name: input.displayName, kind: input.kind, encryptionMode: 'plain',
                            revision: 1, materialStatus: 'ready', capabilities: {
                                use: true, rename: true, rotate: true, manageAccess: true, delete: true,
                            },
                        },
                    });
                account.home.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [resource] } });
                account.home.answer(scope.serverId, '/v1/account/saved-secrets/resources', { body: { resources: [resource.entry] } });
                return { body: { resourceId: input.resourceId, settingsVersion } };
            },
        });
        account.home.answer(scope.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: input => {
            providerWrites += 1;
            const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe(1);
            if (mutation.content?.t === 'plain') importedModelSettings = Reflect.get(
                mutation.content.v.connections.find(connection => connection.id === 'voice-openai-compatible-chat')!, 'modelSettings');
            if (usesResource) {
                expect(mutation.savedSecretRevisions).toEqual([{ resourceId, expectedRevision: 3 }]);
                expect(mutation.referencedSavedSecretIds).toEqual([resourceRef]);
            }
            if (usesPersonalApproval) {
                expect(approvedResourceId).toBeDefined();
                expect(mutation.savedSecretRevisions).toEqual([{ resourceId: approvedResourceId, expectedRevision: 1 }]);
                expect(mutation.referencedSavedSecretIds).toEqual([formatSharedSavedSecretRefV1(approvedResourceId!)]);
            }
            if (outcome === 'provider-conflict') return { respondAfter: ack, body: { status: 'conflict', revision: 2 } };
            account.home.answer(scope.serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { body: {
                status: 'present', revision: 2, content: mutation.content,
            } });
            return { respondAfter: ack, body: outcome === 'owner-unknown-ack' ? {} : { status: 'updated', revision: 2, cursor: 2 } };
        } });
        if (outcome === 'owner-action' || outcome === 'owner-agent-action' || outcome === 'owner-agent-conditional') {
            acknowledge();
            const result = await createDefaultActionExecutor().execute(outcome === 'owner-action' ? 'settings.invoke' : 'settings.set', {
                anchor: 'voiceConversations.agent',
                ...(outcome !== 'owner-action' ? { value: 'agent:happier.agent.opencode/opencode',
                    ...(outcome === 'owner-agent-conditional' ? { expectedSettingsVersion: 1 } : {}) } : {}),
            }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
                presentUserConfirmation: { actionId: outcome === 'owner-action' ? 'settings.invoke' : 'settings.set' } });
            expect(result).toMatchObject(outcome === 'owner-action' ? { ok: true, result: { status: 'completed' } } : { ok: false });
            const { settingsParse } = await import('@/sync/domains/settings/settings');
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat).toMatchObject({
                status: 'needs_selection',
            });
            expect(providerWrites).toBe(1);
            return;
        }
        if (outcome === 'owner-receipt' || outcome === 'owner-same-model' || outcome === 'owner-unknown-ack' || outcome === 'owner-existing-resource' || outcome === 'owner-existing-resource-unrelated') {
            acknowledge();
            const { importLegacyVoiceOpenAiChatProvider } = await import('@/sync/ops/settings/legacyVoiceChatImport');
            const receipt = await importLegacyVoiceOpenAiChatProvider(scope);
            expect(providerWrites).toBe(1);
            expect(importedModelSettings).toEqual({
                'legacy-chat': { temperature: 0.4, maxTokens: 2048 },
                ...(outcome === 'owner-same-model' ? {} : { 'legacy-commit': { temperature: 0.2, maxTokens: 2048 } }),
            });
            if (outcome === 'owner-unknown-ack') {
                expect(providerWrites).toBe(1);
                expect(account.home.findByServerUrl('https://provider-settings-account.test')?.answers.get(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)?.body)
                    .toMatchObject({ status: 'present', revision: 2 });
                expect(receipt).toEqual({ status: 'outcome_unknown' });
                expect(stored).toEqual(original);
                return;
            }
            expect(receipt).toEqual({ status: 'applied', settingsVersion: 2 });
            expect(providerWrites).toBe(1);
            if (usesResource) expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toEqual([]);
            const [{ readLocalConversationVoiceSettings }, { settingsParse }] = await Promise.all([
                import('@/sync/domains/settings/voiceSettings'), import('@/sync/domains/settings/settings'),
            ]);
            expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat).toMatchObject({
                status: 'needs_selection',
            });
            expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat).not.toHaveProperty('configuration');
            return;
        }
        const [{ LocalConversationSection }, { useVoiceSettingsMutable }, { readLocalConversationVoiceSettings }, { settingsParse }, { ModalProvider }] = await Promise.all([
            import('./LocalConversationSection'), import('../useVoiceSettingsMutable'),
            import('@/sync/domains/settings/voiceSettings'), import('@/sync/domains/settings/settings'),
            import('@/modal'),
        ]);
        function Editor() {
            const [voice, setVoice] = useVoiceSettingsMutable();
            return <ModalProvider><LocalConversationSection voice={voice} setVoice={setVoice} /></ModalProvider>;
        }
        const container = document.createElement('div');
        document.body.append(container);
        mounted = { root: createRoot(container), container };
        await act(async () => mounted?.root.render(<Editor />));
        try {
            const trigger = container.querySelector<HTMLElement>('[data-testid="settings.voice.local.agent"] button');
            if (!trigger) throw new Error('missing actual pending Chat Agent dropdown');
            await act(async () => press(trigger));
            await waitForTestEvent(subscribeDom, () => expect(document.querySelector('[data-testid="dropdown-option-agent_happier_agent_opencode_opencode"]')).not.toBeNull());
            await act(async () => press(document.querySelector<HTMLElement>('[data-testid="dropdown-option-agent_happier_agent_opencode_opencode"]')!));
            if (usesPersonalApproval) {
                // Own UI Ask is answered in place; the Action owner does not create an Inbox item.
                const approve = '[data-testid="actions.confirmation-review.decision-approve"]';
                const cancel = '[data-testid="actions.confirmation-review.decision-reject"]';
                await waitForTestEvent(subscribeDom, () => expect(document.querySelector(approve)).not.toBeNull());
                expect(account.home.artifacts(scope.serverId).list()).toHaveLength(0);
                expect(stored).toEqual(original);
                expect(providerWrites).toBe(0);
                expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toEqual([]);
                if (outcome === 'personal-approval-unmounted') {
                    const editor = mounted;
                    await act(async () => editor.root.unmount());
                    editor.container.remove();
                    mounted = null;
                    expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toEqual([]);
                    expect(providerWrites).toBe(0);
                    expect(stored).toEqual(original);
                    return;
                }
                const canceled = outcome === 'personal-approval-canceled';
                await act(async () => press(document.querySelector<HTMLElement>(canceled ? cancel : approve)!));
                if (canceled) {
                    await waitForSaveError();
                    expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toEqual([]);
                    expect(stored).toEqual(original);
                    expect(providerWrites).toBe(0);
                    expect(account.home.artifacts(scope.serverId).list()).toHaveLength(0);
                    return;
                }
            }
            await waitForTestEvent(subscribeHomeOrDom, () => account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                .some(request => request.input !== undefined) || document.body.textContent?.includes(t('common.saveError')), Boolean);
            expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                .some(request => request.input !== undefined) || document.body.textContent?.includes(t('common.saveError'))).toBe(true);
            expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                .some(request => request.input !== undefined)).toBe(true);
            if (usesPersonalApproval) {
                expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toHaveLength(1);
                expect(account.home.artifacts(scope.serverId).list()).toHaveLength(0);
                expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat)
                    .toMatchObject({ status: 'migration_required' });
            } else expect(stored).toEqual(original);
            if (outcome === 'settings-conflict') {
                stored = { ...original, assistantLanguage: 'fr' };
                settingsVersion += 1;
                account.home.answer(scope.serverId, '/v2/account/settings', { body: {
                    content: { t: 'plain', v: stored }, version: settingsVersion,
                } });
            }
            acknowledge();
            if (outcome === 'provider-conflict' || outcome === 'settings-conflict') {
                await waitForSaveError();
                expect(stored.voice).toEqual(original.voice);
                expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat)
                    .toEqual({ status: 'migration_required', reason: 'provider_catalog_import_required' });
                return;
            }
            await waitForTestEvent(account.home.subscribe,
                () => readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat,
                value => value?.status === 'needs_selection');
            expect(readLocalConversationVoiceSettings(settingsParse(stored).voice).agent.providerChat)
                .toMatchObject({ status: 'needs_selection', providerConnectionId: 'voice-openai-compatible-chat',
                    chatModelId: 'legacy-chat', commitModelId: 'legacy-commit' });
            expect(stored).toMatchObject({ voice: { adapters: { local_conversation: {
                agent: expect.not.objectContaining({ openaiCompat: expect.anything() }),
            } } } });
            if (outcome === 'existing-resource') expect(account.home.requestsFor('/v1/account/saved-secrets/resources/promote')).toEqual([]);
            const finalRow = account.home.findByServerUrl('https://provider-settings-account.test')
                ?.answers.get(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)?.body;
            expect(finalRow).toMatchObject({ status: 'present', revision: 2, content: { t: 'plain', v: {
                ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [expect.objectContaining({ id: 'voice-openai-compatible-chat' })],
            } } });
        } finally { acknowledge(); }
    }, 180_000);

    it.each([{ authorized: false, surface: 'ui' }, { authorized: true, surface: 'ui' },
        { authorized: false, surface: 'action' }, { authorized: true, surface: 'action' },
        { authorized: true, surface: 'action_conditional' }] as const)(
      'uses both model admissions before persisting a selection ($surface, authorized: $authorized)', async ({ authorized, surface }) => {
        locks = installWebLockManagerMock();
        const [{ voiceSettingsDefaults, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings },
            { normalizeVoiceSettingsServerDelta }, { storage }] = await Promise.all([
            import('@/sync/domains/settings/voiceSettings'),
            import('@/sync/domains/settings/voiceSettingsPersistence'),
            import('@/sync/domains/state/storage'),
        ]);
        const connectionId = ProviderConnectionIdSchema.parse('voice-openai-compatible-chat');
        const agentTargetKey = 'agent:happier.agent.opencode/opencode';
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation',
            executionMachine: { mode: 'fixed', machineId: 'machine-a' } }, {
            ...local, conversationMode: 'agent', agent: { ...local.agent,
                providerChat: { status: 'needs_selection', providerConnectionId: connectionId,
                    chatModelId: 'legacy-chat', commitModelId: 'legacy-commit' },
            },
        });
        transport.projection = createProviderModelProjectionFixture({ agentTargetKey,
            groups: [createProviderModelProjectionGroupFixture({ connectionId,
                authorization: authorized ? { authorized: true } : { authorized: false,
                    error: { v: 1, code: 'provider_connection_disabled', retryable: false, action: 'enable_connection' } },
                rows: ['legacy-chat', 'legacy-commit'].map(modelId => ({
                    ref: { agentTargetKey, providerConnectionId: connectionId, modelId },
                    descriptor: { id: modelId, name: modelId },
                    sources: { manual: true, static: false, probe: false }, confidence: 'manual',
                    compatibility: { result: { status: 'experimental', selectedProtocol: 'openai-chat',
                        reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId } },
                        compatibilityFingerprint: 'compatibility:v1:legacy-chat', confirmed: true },
                    endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
                })),
            })],
        });
        const scope = await account.restore({ settings: { ...normalizeVoiceSettingsServerDelta({ voice }),
                experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true } },
            machines: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })],
            features: createRootLayoutFeaturesResponse({ features: {
                providers: { enabled: true }, voice: { enabled: true },
            } }),
        });
        // Scoped RPC verifies the current Machine's Home row before dispatching.
        const machine = createPlainMachineRowFixture({ id: 'machine-a', accountId: scope.accountId });
        account.home.answer(scope.serverId, '/v1/machines/machine-a', { body: { machine } });
        account.home.answer(scope.serverId, '/v1/machines/machine-a/access', { body: {
            machineId: machine.id, custodian: machine.access!.custodian, access: machine.access,
            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        } });
        let settingsVersion = 1;
        account.home.answer(scope.serverId, 'POST /v2/account/settings', { select: input => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== settingsVersion) return { status: 409, body: {
                success: false, error: 'version-mismatch', currentVersion: settingsVersion,
                currentContent: { t: 'plain', v: normalizeVoiceSettingsServerDelta({ voice }) },
            } };
            settingsVersion += 1;
            account.home.answer(scope.serverId, '/v2/account/settings', { body: {
                version: settingsVersion, content: request.content,
            } });
            return { body: { success: true, version: settingsVersion } };
        } });
        const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
        await refreshProviderCatalog(scope);
        if (surface === 'action' || surface === 'action_conditional') {
            const result = await createDefaultActionExecutor().execute('settings.set', {
                anchor: 'voiceConversations.agent', value: agentTargetKey,
                ...(surface === 'action_conditional' ? { expectedSettingsVersion: 1 } : {}),
            }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
                presentUserConfirmation: { actionId: 'settings.set' } });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: authorized });
            expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).agent.providerChat?.status)
                .toBe(authorized ? 'configured' : 'needs_selection');
            return;
        }
        const [{ LocalConversationSection }, { useVoiceSettingsMutable }] = await Promise.all([
            import('./LocalConversationSection'), import('../useVoiceSettingsMutable'),
        ]);
        function Editor() {
            const [current, setVoice] = useVoiceSettingsMutable();
            return <LocalConversationSection voice={current} setVoice={setVoice} />;
        }
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        mounted = { root, container };
        await act(async () => root.render(<Editor />));
        const trigger = container.querySelector<HTMLElement>('[data-testid="settings.voice.local.agent"] button');
        if (!trigger) throw new Error('missing actual imported Chat Agent dropdown trigger');
        await act(async () => press(trigger));
        await waitForTestEvent(subscribeDom, () => expect(document.querySelector('[data-testid="dropdown-option-agent_happier_agent_opencode_opencode"]')).not.toBeNull());
        await act(async () => press(document.querySelector<HTMLElement>('[data-testid="dropdown-option-agent_happier_agent_opencode_opencode"]')!));
        await waitForTestEvent(daemon.subscribe, () => transport.projectionReads,
            reads => reads.some(read => !!read && typeof read === 'object'
                && 'agentTargetKey' in read && read.agentTargetKey === agentTargetKey && 'mode' in read && read.mode === 'picker'));
        expect(transport.projectionReads).toContainEqual(expect.objectContaining({ agentTargetKey, mode: 'picker' }));
        await waitForTestEvent(storage.subscribe,
            () => readLocalConversationVoiceSettings(storage.getState().settings.voice).agent.providerChat?.status,
            status => status === (authorized ? 'configured' : 'needs_selection'));
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).agent.providerChat?.status)
            .toBe(authorized ? 'configured' : 'needs_selection');
    }, 180_000);
});
