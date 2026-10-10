import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
    buildLinkedExternalSessionMetadataV1,
    accountSettingsParse,
    V2SessionByIdResponseSchema,
    type ExternalAgentObservationSnapshotV1,
    type LinkedExternalSessionQualifiedIdentityV1,
    type SessionMetadata,
} from '@happier-dev/protocol';

import {
    createExternalAgentObservationFieldPublisher,
} from './publishExternalAgentObservationField';
import { createSessionNotificationContextFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as pinnedHttp from '@/network/pinnedHttp';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import type { patchSessionMetadataEnvelopeTuple } from '@/session/transport/http/sessionsHttp';

function snapshot(
    boundary?: Readonly<{ id: string; observedAtMs: number }>,
): ExternalAgentObservationSnapshotV1 {
    return {
        v: 1,
        qualifiedLinkIdentity: {
            v: 1,
            agent: {
                pluginId: 'happier.agent.opencode',
                localId: 'opencode',
            },
            source: {
                kind: 'opencodeServer',
                contractVersion: 1,
            },
        },
        linkGeneration: '1000',
        status: 'idle',
        observedAtMs: 2_000,
        expiresAtMs: 3_000,
        ...(boundary ? { boundary } : {}),
    };
}

const QUALIFIED_LINK_IDENTITY = snapshot().qualifiedLinkIdentity;

function linkedMetadata(input?: Readonly<{
    linkedAtMs?: number;
    qualifiedIdentity?: LinkedExternalSessionQualifiedIdentityV1;
}>): SessionMetadata {
    const qualifiedIdentity =
        input?.qualifiedIdentity ?? QUALIFIED_LINK_IDENTITY;
    const isClaude =
        qualifiedIdentity.source.kind === 'claudeConfig';
    return buildLinkedExternalSessionMetadataV1(
        {
            summary: { text: 'External review', updatedAt: 1_000 },
            preservedMetadata: 'preserved',
        },
        {
            v: 1,
            agentId: isClaude ? 'claude' : 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: isClaude
                ? {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude',
                }
                : {
                    kind: 'opencodeServer',
                    directory: null,
                },
            qualifiedIdentity,
            linkedAtMs: input?.linkedAtMs ?? 1_000,
        },
    ) as SessionMetadata;
}

function setup(params?: Readonly<{
    shouldSendReadyNotification?: () => boolean;
    dispatchReadyNotification?: (input: Readonly<{
        sessionId: string;
        sessionTitle: string | null;
        boundaryId: string;
    }>) => Promise<void>;
    relinkedMetadataOnRetry?: SessionMetadata;
}>) {
    let metadata = linkedMetadata();
    let metadataWriteCount = 0;
    const dispatchReadyNotification = vi.fn(
        params?.dispatchReadyNotification ?? (async () => {}),
    );
    const updateMetadataForTarget = vi.fn(async (input: Readonly<{
        idOrPrefix: string;
        updater(metadata: SessionMetadata): SessionMetadata | Promise<SessionMetadata>;
    }>) => {
        const firstAttempt = await input.updater(metadata);
        if (params?.relinkedMetadataOnRetry) {
            metadata = params.relinkedMetadataOnRetry;
            metadata = await input.updater(metadata);
        } else {
            metadata = firstAttempt;
        }
        metadataWriteCount += 1;
        return {
            ok: true as const,
            sessionId: input.idOrPrefix,
            metadata,
            version: 1,
        };
    });
    const createPublisher = () => createExternalAgentObservationFieldPublisher({
        shouldSendReadyNotification:
            params?.shouldSendReadyNotification ?? (() => true),
        readCredentials: async () => ({ token: 'token' } as never),
        updateMetadataForTarget: updateMetadataForTarget as never,
        dispatchReadyNotification,
    });
    return {
        createPublisher,
        dispatchReadyNotification,
        readMetadataWriteCount: () => metadataWriteCount,
        readMetadata: () => metadata,
        replaceMetadata: (next: SessionMetadata) => {
            metadata = next;
        },
    };
}

describe('publishExternalAgentObservationField', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        resetActiveAccountSettingsSnapshotForTests();
    });

    it.each(['status_only', 'title_only', 'include_preview'] as const)(
      'uses current Follow facts and %s privacy for the real external-ready webhook path', async (previewBehavior) => {
        const sessionId = 'c123456789012345678901234';
        let suppressed = true;
        const { preservedMetadata: _preserved, ...metadata } = linkedMetadata();
        const fields = buildSessionMetadataEnvelopeFields({
            credentials: { token: 'external-token', encryption: null },
            accountEncryptionMode: 'plain', storedContentMode: 'plain', metadata, agentState: null,
        });
        const rawSession = {
            ...createSessionNotificationContextFixture(sessionId),
            encryptionMode: 'plain' as const,
            share: null,
            metadataLayoutVersion: fields.metadataLayoutVersion,
            metadata: fields.sharedMetadata.ciphertext,
            ownerMetadata: fields.ownerMetadata,
        };
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) {
                return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            }
            const viewer = rawSession.viewer!;
            return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: { ...rawSession, viewer: {
                ...viewer, follow: { follows: false, notificationLevel: suppressed ? 'none' : null },
            } } }) };
        });
        vi.spyOn(axios, 'patch').mockImplementation(async (_url, body: unknown) => {
            const patch = body as Extract<Parameters<typeof patchSessionMetadataEnvelopeTuple>[0]['patch'], { mode: 'owner' }>;
            rawSession.metadata = patch.sharedMetadata.ciphertext;
            rawSession.ownerMetadata = patch.ownerMetadata;
            rawSession.metadataVersion = patch.sharedMetadata.expectedVersion + 1;
            rawSession.agentState = patch.agentState.ciphertext;
            rawSession.agentStateVersion = patch.agentState.expectedVersion + 1;
            return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: rawSession.metadataVersion }, agentState: { version: rawSession.agentStateVersion },
            } };
        });
        const requests: pinnedHttp.PinnedHttpStreamRequest[] = [];
        vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockImplementation(async (request) => {
            requests.push(request);
            return { status: 202, headers: {}, contentLength: 0, read: async () => null, cancel: () => {} };
        });
        setActiveAccountSettingsSnapshot({
            source: 'network', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: runWithServerHttpBaseUrl('https://external-home.example.test', () => resolveAccountSettingsScopeKeyForToken('external-token')),
            settings: accountSettingsParse({
                attentionDeliveryPolicyV1: { v: 1, privacy: { defaultPreviewBehavior: previewBehavior } },
            }), notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [NotificationChannelRecordV1Schema.parse({
                v: 1, id: 'external-ready', kind: 'webhook', enabled: true,
                url: 'https://93.184.216.34/happier', topics: { ready: true }, signingSecretRef: null,
            })] },
        });
        const publish = createExternalAgentObservationFieldPublisher({
            shouldSendReadyNotification: () => true,
            readCredentials: async () => ({ token: 'external-token', encryption: null }),
        });
        const send = (id: string, observedAtMs = suppressed ? 2_000 : 3_000) => runWithServerHttpBaseUrl('https://external-home.example.test', () => publish({
            sessionId, fieldId: 'runtime.externalAgent', value: snapshot({ id, observedAtMs }),
        }));
        await send('boundary-muted');
        expect(requests).toHaveLength(0);
        suppressed = false;
        await send('boundary-enabled');
        expect(requests).toHaveLength(1);
        const payload = JSON.parse(Buffer.from(requests[0]!.body!).toString('utf8'));
        expect(JSON.stringify(payload).includes('External review')).toBe(previewBehavior !== 'status_only');
        if (previewBehavior === 'status_only') {
            expect(payload.content).toEqual({ title: 'Session', body: 'Session is waiting for your command' });
        }
        expect(axios.get).toHaveBeenCalledWith(
            `https://external-home.example.test/v2/sessions/${sessionId}?accessProjectionVersion=1`,
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer external-token' }) }),
        );
        const incumbent = getActiveAccountSettingsSnapshot();
        if (!incumbent) throw new Error('Notification Account fixture retired');
        setActiveAccountSettingsSnapshot({ ...incumbent,
            scopeKey: runWithServerHttpBaseUrl('https://external-home.example.test', () => resolveAccountSettingsScopeKeyForToken('different-account-token')) });
        await send('boundary-foreign-account', 4_000);
        expect(requests).toHaveLength(1);
    });

    it('uses the canonical boundary advancement to suppress replay after restart', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_500 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.dispatchReadyNotification).toHaveBeenCalledWith({
            sessionId: 'session-1',
            sessionTitle: 'External review',
            boundaryId: 'boundary-1',
        });
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('does not retry an attempted boundary after dispatch failure and restart', async () => {
        const owner = setup({
            dispatchReadyNotification: async () => {
                throw new Error('notification transport failed');
            },
        });

        await expect(owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        })).resolves.toBeUndefined();
        await expect(owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        })).resolves.toBeUndefined();

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
    });

    it('publishes markerless mid-turn activity without notification', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot(),
                status: 'working',
            },
        });

        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                status: 'working',
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
    });

    it('does not let a markerless update erase replay protection', async () => {
        const owner = setup();

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot(),
                status: 'working',
            },
        });
        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_500 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                status: 'idle',
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('advances a viewed boundary without notifying and does not notify its later replay', async () => {
        let viewerAttached = true;
        const owner = setup({
            shouldSendReadyNotification: () => !viewerAttached,
        });
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-viewed', observedAtMs: 2_000 }),
        });
        viewerAttached = false;
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-viewed', observedAtMs: 2_000 }),
        });

        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
    });

    it('scopes boundary replay suppression to the qualified link generation', async () => {
        const owner = setup();
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
        });
        owner.replaceMetadata({
            ...linkedMetadata({ linkedAtMs: 2_000 }),
            externalAgentObservationV1:
                owner.readMetadata().externalAgentObservationV1,
        });
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                ...snapshot({ id: 'boundary-1', observedAtMs: 2_000 }),
                linkGeneration: '2000',
            },
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(2);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                linkGeneration: '2000',
                boundary: {
                    id: 'boundary-1',
                    observedAtMs: 2_000,
                },
            },
        });
    });

    it('drops a stale observation when a metadata retry sees a concurrent relink', async () => {
        const relinkedMetadata = linkedMetadata({
            linkedAtMs: 2_000,
        });
        const owner = setup({ relinkedMetadataOnRetry: relinkedMetadata });

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-stale', observedAtMs: 2_000 }),
        });

        expect(owner.readMetadata()).toEqual(relinkedMetadata);
        expect(owner.readMetadata()).not.toHaveProperty(
            'externalAgentObservationV1',
        );
        expect(owner.readMetadata()).toMatchObject({
            preservedMetadata: 'preserved',
            externalSessionV1: {
                linkedAtMs: 2_000,
                qualifiedIdentity: QUALIFIED_LINK_IDENTITY,
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
        expect(owner.readMetadataWriteCount()).toBe(0);
    });

    it('drops a stale observation when durable qualified identity no longer matches', async () => {
        const relinkedMetadata = linkedMetadata({
            linkedAtMs: 1_000,
            qualifiedIdentity: {
                ...QUALIFIED_LINK_IDENTITY,
                agent: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1,
                },
            },
        });
        const owner = setup({ relinkedMetadataOnRetry: relinkedMetadata });

        await owner.createPublisher()({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot(),
        });

        expect(owner.readMetadata()).toEqual(relinkedMetadata);
        expect(owner.readMetadata()).not.toHaveProperty(
            'externalAgentObservationV1',
        );
        expect(owner.readMetadata()).toMatchObject({
            preservedMetadata: 'preserved',
            externalSessionV1: {
                linkedAtMs: 1_000,
                qualifiedIdentity: {
                    agent: {
                        pluginId: 'happier.agent.claude',
                        localId: 'claude',
                    },
                    source: {
                        kind: 'claudeConfig',
                    },
                },
            },
        });
        expect(owner.dispatchReadyNotification).not.toHaveBeenCalled();
        expect(owner.readMetadataWriteCount()).toBe(0);
    });

    it('preserves a newer canonical boundary against stale publication', async () => {
        const owner = setup();
        const publisher = owner.createPublisher();

        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-new', observedAtMs: 3_000 }),
        });
        await publisher({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: snapshot({ id: 'boundary-old', observedAtMs: 2_000 }),
        });

        expect(owner.dispatchReadyNotification).toHaveBeenCalledTimes(1);
        expect(owner.readMetadata()).toMatchObject({
            externalAgentObservationV1: {
                boundary: {
                    id: 'boundary-new',
                    observedAtMs: 3_000,
                },
            },
        });
    });
});
