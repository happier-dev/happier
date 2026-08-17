import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PluginWebhookAccountStatusResultV1Schema,
    PluginWebhookDeliveryDiscardResultV1Schema,
    PluginWebhookDeliveryReplayResultV1Schema,
    PluginWebhookEndpointCredentialConfigureResultV1Schema,
} from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginWebhookAdministrationHttpClient } from '@/sync/api/plugins/webhooks/endpointActions';

const resolveExecutionOrigin = vi.hoisted(() => vi.fn(() => null));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const translate = (key: string, params?: Record<string, unknown>) => params
        ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
        : key;
    return createTextModuleMock({ translate, translateLoose: translate });
});

vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReleaseClassifier: () => vi.fn(),
}));

vi.mock('@/sync/domains/machines/administration/usePluginExecutionOriginSelection', () => ({
    usePluginMachineExecutionOriginSelection: () => ({
        candidates: [],
        state: { kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] },
        selectedOrigin: null,
        canExecute: false,
        selectOrigin: vi.fn(),
        clearOrigin: vi.fn(),
        resolveExecutionOrigin,
    }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => {
    standardCleanup();
    resolveExecutionOrigin.mockClear();
});

function createClient(): PluginWebhookAdministrationHttpClient {
    return {
        executeAction: vi.fn(async () => ({ kind: 'revoked', revision: 2 })),
        readStatus: vi.fn(async () => PluginWebhookAccountStatusResultV1Schema.parse({
            endpoints: [{
                webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                revision: 1,
                contribution: { pluginId: 'acme.github', localId: 'issues' },
                targetMaterialization: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                    pluginId: 'acme.github',
                },
                sourceInstanceId: 'source-1',
                routing: 'accountEndpoint',
                readiness: 'ready',
                targetStatus: 'current',
                publicUrl: 'https://server.example/v1/plugins/webhooks/opaque',
                createdAt: 1,
                queue: { queued: 1, retrying: 2, claimed: 0, deadLetter: 1, oldestPendingAtMs: 1 },
            }],
            nextEndpointCursor: null,
            deadLetters: [{
                deliveryId: 'delivery-dead',
                webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                revision: 3,
                deliveryIdentityDigestPrefix: 'aaaaaaaaaaaa',
                errorCode: 'handler_failed',
                attemptCount: 12,
                replayCount: 0,
                receivedAtMs: 1,
                deadLetteredAtMs: 2,
                targetMaterialization: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                    pluginId: 'acme.github',
                },
                automationAdmissionUnresolved: {
                    v: 1,
                    kind: 'automationAdmissionUnresolved',
                    totalCount: 2,
                    entries: [
                        {
                            automationId: 'automation-a',
                            status: { kind: 'blocked', reason: 'capacity' },
                        },
                        {
                            automationId: 'automation-b',
                            status: { kind: 'refreshDefinition', reason: 'definitionStale' },
                        },
                    ],
                    omittedCount: 0,
                },
            }],
        })),
        replayDelivery: vi.fn(async () => PluginWebhookDeliveryReplayResultV1Schema.parse({ kind: 'requeued', revision: 4 })),
        discardDelivery: vi.fn(async () => PluginWebhookDeliveryDiscardResultV1Schema.parse({ kind: 'discarded', revision: 4 })),
    };
}

describe('PluginWebhookAdministrationScreen', () => {
    it('renders endpoint and bounded dead-letter status without a raw delivery body', async () => {
        const client = createClient();
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);

        expect(client.readStatus).toHaveBeenCalledWith({ pageSize: 100, deadLetterPageSize: 100 });
        expect(screen.getTextContent()).toContain('acme.github / issues');
        expect(screen.getTextContent()).toContain('aaaaaaaaaaaa');
        expect(screen.getTextContent()).toContain('totalCount=2');
        expect(screen.getTextContent()).toContain('automation-a (blocked:capacity)');
        expect(screen.getTextContent()).toContain('omittedCount=0');
        expect(screen.getTextContent()).not.toContain('rawBody');
        expect(screen.getTextContent()).not.toContain('providerDeliveryId');
    });

    it('replays a dead letter with its displayed revision and refreshes current status', async () => {
        const client = createClient();
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
        const replay = screen.find((node) => node.props?.testID === 'settings.plugins.webhooks.delivery.delivery-dead.replay');

        await pressTestInstanceAsync(replay, 'replay dead-letter delivery');

        expect(client.replayDelivery).toHaveBeenCalledWith({ deliveryId: 'delivery-dead', expectedRevision: 3 });
        expect(client.readStatus).toHaveBeenCalledTimes(2);
    });

    it('walks the endpoint cursor so unavailable and unattached endpoints are not hidden after the first page', async () => {
        const client = createClient();
        const fixture = await client.readStatus({ pageSize: 100, deadLetterPageSize: 100 });
        const readStatus = vi.mocked(client.readStatus);
        readStatus.mockReset();
        readStatus
            .mockResolvedValueOnce({
                ...fixture,
                nextEndpointCursor: fixture.endpoints[0]!.webhookEndpointId,
            })
            .mockResolvedValueOnce({
                endpoints: [{
                    ...fixture.endpoints[0]!,
                    webhookEndpointId: 'wh_ep_AQECAwQFBgcICQoLDA0ODw',
                    sourceInstanceId: 'source-unattached',
                    readiness: 'targetUnavailable',
                    targetStatus: 'unavailable',
                }],
                nextEndpointCursor: null,
                deadLetters: [],
            });
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);

        expect(readStatus).toHaveBeenNthCalledWith(1, { pageSize: 100, deadLetterPageSize: 100 });
        expect(readStatus).toHaveBeenNthCalledWith(2, {
            endpointCursor: fixture.endpoints[0]!.webhookEndpointId,
            pageSize: 100,
            deadLetterPageSize: 0,
        });
        expect(screen.getTextContent()).toContain('source-unattached');
    });

    it('resumes a partial prior-target delivery move from persisted endpoint status', async () => {
        const client = createClient();
        const fixture = await client.readStatus({ pageSize: 100, deadLetterPageSize: 100 });
        vi.mocked(client.readStatus).mockResolvedValue({
            ...fixture,
            endpoints: [{
                ...fixture.endpoints[0]!,
                pendingTargetTransfer: {
                    previousTargetMaterialization: {
                        machineId: 'machine-old',
                        materializationId: 'materialization-old',
                        pluginId: 'acme.github',
                    },
                    eligibleDeliveryCount: 2,
                },
            }],
        });
        vi.mocked(client.executeAction).mockResolvedValueOnce({
            moved: 2,
            skippedClaimed: 0,
            nextCursor: null,
            done: true,
        });
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
        const resume = screen.find((node) => (
            node.props?.testID === 'settings.plugins.webhooks.endpoint.wh_ep_AAECAwQFBgcICQoLDA0ODw.movePending'
        ));

        await pressTestInstanceAsync(resume, 'resume prior-target delivery move');

        expect(client.executeAction).toHaveBeenCalledWith('plugin.webhook.delivery.movePending', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            endpointRevision: 1,
            previousTargetMaterialization: {
                machineId: 'machine-old',
                materializationId: 'materialization-old',
                pluginId: 'acme.github',
            },
            targetMaterialization: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.github',
            },
            pageSize: 500,
        });
        expect(client.readStatus).toHaveBeenCalledTimes(3);
    });

    it('configures a missing account-endpoint credential through the canonical present-user action', async () => {
        const client = createClient();
        const fixture = await client.readStatus({ pageSize: 100, deadLetterPageSize: 100 });
        vi.mocked(client.executeAction).mockResolvedValueOnce(
            PluginWebhookEndpointCredentialConfigureResultV1Schema.parse({
                kind: 'configured',
                webhookEndpointId: fixture.endpoints[0]!.webhookEndpointId,
                revision: 2,
                credentialVersionId: 'credential-current',
                oneTimeGeneratedSecret: 'one-time-secret',
            }),
        );
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
        const configure = screen.find((node) => (
            node.props?.testID === 'settings.plugins.webhooks.endpoint.wh_ep_AAECAwQFBgcICQoLDA0ODw.configureCredential'
        ));

        await pressTestInstanceAsync(configure, 'configure signing credential');

        expect(client.executeAction).toHaveBeenCalledWith('plugin.webhook.endpoint.credential.configure', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            expectedRevision: 1,
        });
        const { Modal } = await import('@/modal');
        expect(Modal.alertAsync).toHaveBeenCalledWith(
            'settingsPlugins.webhookAdministration.credentialSecretTitle',
            'settingsPlugins.webhookAdministration.credentialSecretBody(secret=one-time-secret)',
        );
        // The fixture read establishes the endpoint revision; the screen then
        // loads status and refreshes it after the present-user action.
        expect(client.readStatus).toHaveBeenCalledTimes(3);
    });

    it('finishes a credential rotation recovered from persisted non-secret status', async () => {
        const client = createClient();
        const fixture = await client.readStatus({ pageSize: 100, deadLetterPageSize: 100 });
        vi.mocked(client.readStatus).mockResolvedValue({
            ...fixture,
            endpoints: [{
                ...fixture.endpoints[0]!,
                revision: 3,
                credentialRotation: {
                    previousCredentialVersionId: 'credential-previous',
                    previousAcceptUntilMs: 2,
                },
            }],
        });
        vi.mocked(client.executeAction).mockResolvedValueOnce({
            kind: 'retired',
            webhookEndpointId: fixture.endpoints[0]!.webhookEndpointId,
            revision: 4,
        });
        const { PluginWebhookAdministrationScreen } = await import('./PluginWebhookAdministrationScreen');
        const screen = await renderScreen(<PluginWebhookAdministrationScreen client={client} />);
        const finish = screen.find((node) => (
            node.props?.testID === 'settings.plugins.webhooks.endpoint.wh_ep_AAECAwQFBgcICQoLDA0ODw.finishRotation'
        ));

        await pressTestInstanceAsync(finish, 'finish recovered credential rotation');

        expect(client.executeAction).toHaveBeenCalledWith('plugin.webhook.endpoint.credential.finishRotation', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            expectedRevision: 3,
            expectedPreviousCredentialVersionId: 'credential-previous',
        });
    });
});
