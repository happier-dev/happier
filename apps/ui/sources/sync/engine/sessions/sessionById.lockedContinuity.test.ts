import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { Session } from '@/sync/domains/state/storageTypes';

import { fetchAndApplySessionById, type SessionByIdEncryption } from './sessionById';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    sealEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    sealSessionOwnerMetadataEnvelopeV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import {
    V2SessionRecordSchema,
} from '@happier-dev/protocol/sessions/control/contract';
import { fetchAndApplySessions as fetchAndApplySessionsSource } from './sessionSnapshot';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListCacheEntryFromRenderable } from '@/sync/domains/state/warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from '@/sync/domains/state/warmCachePersistence';
import { createDataKeyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

/**
 * Single-Session hydration must settle. A Session the viewer is authorized to see but cannot
 * decrypt is a locked Session with a truthful state, not a retryable failure that leaves the route
 * spinning, and never a reason to reach for owner-only Account material.
 */

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
} satisfies AccountEncryptionCurrentnessResponse;
const E2EE_ACCOUNT_CURRENTNESS = {
    ...PLAIN_ACCOUNT_CURRENTNESS,
    mode: 'e2ee',
    signingKeyFingerprint: 'signing-current',
    contentKeyFingerprint: 'content-current',
    recipientEnvelopeReadiness: { status: 'available' },
} satisfies AccountEncryptionCurrentnessResponse;

const LEGACY_CREDENTIALS = { token: 't', secret: 's' } as AuthCredentials;

function sessionResponse(session: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ session }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function fetchAndApplySessions(params: Parameters<typeof fetchAndApplySessionsSource>[0]) {
    const request = params.request;
    return fetchAndApplySessionsSource({ ...params,
        ...(request ? { request: createCompactSessionListFetchBoundary(async (path, init) => path === '/v2/sessions/read-batch'
            ? undefined : request(path, init)) } : {}),
    });
}

function buildRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        id: 's_locked',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
        metadataLayoutVersion: 0,
        metadataVersion: 4,
        metadata: 'encrypted-metadata',
        agentStateVersion: 5,
        agentState: null,
        share: null,
        ...overrides,
    };
}

function createEncryption(openEnvelope: (value: string) => Uint8Array | null = () => null) {
    const initializedSessionIds = new Set<string>();
    const decryptEncryptionKey = vi.fn(async (value: string) => openEnvelope(value));
    const initializeSessions = vi.fn(async (sessionKeys: Map<string, Uint8Array | null>) => {
        for (const sessionId of sessionKeys.keys()) initializedSessionIds.add(sessionId);
    });
    const removeSessionEncryption = vi.fn((sessionId: string) => {
        initializedSessionIds.delete(sessionId);
    });
    const getSessionEncryption = vi.fn((sessionId: string) => (
        initializedSessionIds.has(sessionId)
            ? {
                decryptMetadata: async (_version: number, value: string) => ({ decrypted: value }),
                decryptMetadataPayload: async (_version: number, value: string) => ({ decrypted: value }),
                decryptAgentState: async () => null,
                decryptAgentStateResult: async (_version: number, value: string | null | undefined) => value === undefined
                    ? { status: 'unavailable' as const }
                    : { status: 'available' as const, value: null },
            }
            : null
    ));
    const encryption = {
        decryptEncryptionKey,
        initializeSessions,
        removeSessionEncryption,
        getSessionEncryption,
    } as unknown as SessionByIdEncryption;
    return { encryption, decryptEncryptionKey, initializeSessions, removeSessionEncryption };
}

async function openOwnerRowFixture(row: Record<string, unknown>, credentials: AuthCredentials, encryption: Encryption,
    accountCurrentness: AccountEncryptionCurrentnessResponse) {
    let opened: Session | undefined;
    await fetchAndApplySessions({ credentials, accountCurrentness, encryption,
        sessionDataKeys: new Map(), request: async () => Response.json({ sessions: [row], nextCursor: null, hasNext: false }),
        requiredHydrationSessionIds: ['s_locked'], awaitSessionListHydration: true,
        applySessions: sessions => { opened = sessions[0]; }, log: { log() {} },
    });
    if (!opened || opened.encryptedContentAvailability !== 'ready' || !hasAuthoritativeSessionRouteData(opened)) {
        throw new Error('The owner fixture did not open its full documents');
    }
    const renderable = buildSessionListRenderableFromSession(opened);
    const cache = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(buildSessionListCacheEntryFromRenderable(renderable))));
    return { session: opened, renderable, cache };
}

async function encryptOwnerSharedMetadata(encryption: Encryption) {
    await encryption.initializeSessions(new Map([['s_locked', null]]));
    return encryption.getSessionEncryption('s_locked')!.encryptRaw(projectSessionSharedMetadataV1({
        metadata: { summary: { text: 'Shared title', updatedAt: 1 } },
    }));
}

async function hydrateRow(params: Readonly<{
    row: Record<string, unknown>;
    encryption: ReturnType<typeof createEncryption>;
    credentials?: AuthCredentials;
}>) {
    const applySessions = vi.fn();
    const result = await fetchAndApplySessionById({
        sessionId: 's_locked',
        accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
        credentials: params.credentials ?? LEGACY_CREDENTIALS,
        encryption: params.encryption.encryption,
        sessionDataKeys: new Map<string, Uint8Array>(),
        sessionDataKeyEnvelopes: new Map<string, string>(),
        request: async () => sessionResponse(params.row),
        applySessions,
        log: { log: () => {} },
        includeTurnsProjection: false,
    });
    return { result, applySessions, applied: applySessions.mock.calls[0]?.[0]?.[0] };
}

describe('fetchAndApplySessionById locked continuity', () => {
    it('keeps a newer locked Session visible after store admission of an older locked shell', async () => {
        const existingSession = {
            ...buildRow({ metadataVersion: 5, agentStateVersion: 6 }),
            serverId: 'server-a',
            metadata: null,
            agentState: null,
            thinking: false,
            thinkingAt: 0,
            encryptedContentAvailability: 'encrypted_access_pending',
        } as Session;
        const applySessions = vi.fn();
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            serverId: 'server-a',
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: LEGACY_CREDENTIALS,
            encryption: createEncryption().encryption,
            sessionDataKeys: new Map(),
            request: async () => sessionResponse(buildRow({
                share: { accessLevel: 'view', canApprovePermissions: false },
            })),
            applySessions,
            getExistingSession: () => existingSession,
            log: { log: () => {} },
            includeTurnsProjection: false,
            includeMetadataTupleMutationSnapshot: true,
        });

        expect(result).toMatchObject({
            ok: true,
            session: existingSession,
            metadataTupleMutationSnapshot: null,
        });
        expect(applySessions).toHaveBeenCalledOnce();
    });

    it.each([
        ['different server', 'server-b', 'e2ee'],
        ['different encryption mode', 'server-a', 'plain'],
    ] as const)('rejects a newer stored locked Session from a %s scope', async (_scope, serverId, encryptionMode) => {
        const existingSession = {
            ...buildRow({ metadataVersion: 5, agentStateVersion: 6 }),
            serverId,
            encryptionMode,
            metadata: null,
            agentState: null,
        } as Session;
        const applySessions = vi.fn();
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            serverId: 'server-a',
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: LEGACY_CREDENTIALS,
            encryption: createEncryption().encryption,
            sessionDataKeys: new Map(),
            request: async () => sessionResponse(buildRow({
                share: { accessLevel: 'view', canApprovePermissions: false },
            })),
            applySessions,
            getExistingSession: () => existingSession,
            log: { log: () => {} },
            includeTurnsProjection: false,
        });

        expect(result).toMatchObject({
            ok: false,
            session: null,
            errorCode: 'stale_response',
        });
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('treats a settled locked carrier as authoritative route data without requiring decrypted metadata', () => {
        expect(hasAuthoritativeSessionRouteData({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: null,
            encryptedContentAvailability: 'encrypted_access_pending',
        })).toBe(true);
    });

    it('gives list and route one locked outcome when owner metadata cannot open, then replaces it after recovery', async () => {
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1({
            v: 1,
            workspace: { path: '/private/current' },
        });
        const row = buildRow({
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataLayoutVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { summary: { text: 'Shared', updatedAt: 1 } } })),
            ownerMetadata,
            effectiveAccess: {
                v: 1,
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
            },
        });
        const listApplied: Session[] = [];
        await fetchAndApplySessions({
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: LEGACY_CREDENTIALS,
            encryption: null,
            sessionDataKeys: new Map(),
            request: async () => Response.json({ sessions: [row], nextCursor: null, hasNext: false }),
            applySessions: (sessions) => listApplied.push(...sessions as Session[]),
            requiredHydrationSessionIds: ['s_locked'],
            awaitSessionListHydration: true,
            log: { log: () => {} },
        });
        const routeApplied: Session[] = [];
        const request = async () => sessionResponse(row);
        const unavailable = await fetchAndApplySessionById({
            sessionId: 's_locked',
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: LEGACY_CREDENTIALS,
            encryption: createEncryption().encryption,
            sessionDataKeys: new Map(),
            request,
            applySessions: (sessions) => routeApplied.push(...sessions as Session[]),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });
        expect(unavailable.ok).toBe(true);
        expect(listApplied).toHaveLength(1);
        expect(routeApplied).toHaveLength(1);
        for (const shell of [listApplied[0], routeApplied[0]]) {
            expect(shell).toMatchObject({
                metadata: null,
                ownerMetadataView: null,
                agentState: null,
                encryptedContentAvailability: 'encrypted_content_unavailable',
            });
            expect(hasAuthoritativeSessionRouteData(shell, { hasSessionEncryption: false })).toBe(true);
        }

        const recovered: Session[] = [];
        const available = await fetchAndApplySessionById({
            sessionId: 's_locked',
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            credentials: LEGACY_CREDENTIALS,
            encryption: createEncryption().encryption,
            sessionDataKeys: new Map(),
            request,
            applySessions: (sessions) => recovered.push(...sessions as Session[]),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });
        expect(available.ok).toBe(true);
        expect(recovered[0]).toMatchObject({
            ownerMetadataView: { path: '/private/current' },
            encryptedContentAvailability: 'ready',
        });
        expect(hasAuthoritativeSessionRouteData(recovered[0], { hasSessionEncryption: false })).toBe(true);
    });

    it.each([
        ['encryption_setup_required', 'recipient_encryption_setup_required'],
        ['encryption_inconsistent', 'encrypted_access_needs_repair'],
    ] as const)('uses the Account-owned %s result while retaining the authorized Session', async (reason, availability) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const applied: unknown[] = [];
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            credentials: { token: 't' },
            encryption,
            sessionDataKeys: new Map(),
            request: async (path) => path === '/v1/account/encryption/currentness'
                ? new Response(JSON.stringify({
                    error: 'migration-required',
                    recipientEnvelopeReadiness: { status: 'unavailable', reason },
                }), { status: 400 })
                : sessionResponse(buildRow({ share: { accessLevel: 'view', canApprovePermissions: false } })),
            applySessions: (sessions) => applied.push(...sessions),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });
        expect(result.ok).toBe(true);
        expect(applied).toEqual([expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: availability,
        })]);
    });

    it('keeps a current recipient snapshot locked without installing the owner Account reader', async () => {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        const applied: unknown[] = [];
        await fetchAndApplySessions({
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: { token: 't', secret: encodeBase64(secret, 'base64') },
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => new Response(JSON.stringify({
                sessions: [V2SessionRecordSchema.parse(buildRow({
                    // Current recipient transport is privacy-projected; the separate legacy owner case stays layout 0.
                    metadataLayoutVersion: 1,
                    share: undefined,
                    effectiveAccess: {
                        v: 1,
                        level: 'view',
                        sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
                        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view', canApprovePermissions: false }),
                    },
                }))],
                nextCursor: null,
                hasNext: false,
            }), { status: 200 }),
            applySessions: (sessions) => applied.push(...sessions),
            log: { log: () => {} },
        });
        expect(encryption.getSessionEncryption('s_locked')).toBeNull();
        expect(applied).toEqual([expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: 'encrypted_access_pending',
        })]);
    });

    it.each([
        ['ordinary_owner_session', false, true],
        ['voice_carrier', true, false],
    ] as const)('uses independently opened owner metadata to classify a locked owner (%s)', async (key, hidden, visible) => {
        const contentKeys = tweetnacl.box.keyPair();
        const accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: contentKeys.secretKey, publicKey: contentKeys.publicKey });
        const credentials = {
            token: 't',
            encryption: {
                publicKey: encodeBase64(contentKeys.publicKey, 'base64'),
                machineKey: encodeBase64(contentKeys.secretKey, 'base64'),
            },
        } satisfies AuthCredentials;
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            ownerMetadata: {
                v: 1,
                system: { systemSessionV1: { v: 1, key, hidden } },
                workspace: { name: 'Account-owned locked title', path: '/private/worktree', host: 'private-host' },
            },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: contentKeys.publicKey,
            machineKey: contentKeys.secretKey,
        });
        const applied: unknown[] = [];

        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            accountCurrentness,
            credentials,
            encryption,
            sessionDataKeys: new Map(),
            request: async () => sessionResponse(buildRow({
                metadataLayoutVersion: 1,
                ownerMetadata,
                effectiveAccess: {
                    v: 1,
                    level: 'owner',
                    sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({
                        level: 'owner',
                        canApprovePermissions: true,
                    }),
                },
            })),
            applySessions: (sessions) => applied.push(...sessions),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });

        expect(result.ok).toBe(true);
        expect(applied).toHaveLength(1);
        expect(result.session?.ownerMetadataView).toEqual({
            name: 'Account-owned locked title', path: '', host: '', systemSessionV1: { v: 1, key, hidden },
        });
        expect(result.session?.metadata).toBeNull();
        // Owner fallback installs a reader; the deliberately invalid metadata fails authentication.
        expect(result.sessionDataKeyHydration?.states.get('s_locked')).toBe('legacy_fallback_ready');
        expect(result.session?.encryptedContentAvailability).toBe('encrypted_content_unavailable');
        expect(result.session && sessionDisplayTitle({ ...result.session, id: 's_locked' })).toBe('Account-owned locked title');
        expect(isUserFacingSession(applied[0] as Parameters<typeof isUserFacingSession>[0]))
            .toBe(visible);
    });

    it('keeps an owner row visible when a list refresh reuses the warm-cache owner projection', async () => {
        const contentKeys = tweetnacl.box.keyPair();
        const accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: contentKeys.secretKey, publicKey: contentKeys.publicKey });
        const credentials = {
            token: 't',
            encryption: {
                publicKey: encodeBase64(contentKeys.publicKey, 'base64'),
                machineKey: encodeBase64(contentKeys.secretKey, 'base64'),
            },
        } satisfies AuthCredentials;
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            ownerMetadata: { v: 1, workspace: { path: '/home/u/owner', name: 'Owner title' } },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: contentKeys.publicKey,
            machineKey: contentKeys.secretKey,
        });
        const row = buildRow({
            metadataLayoutVersion: 1,
            metadata: await encryptOwnerSharedMetadata(encryption),
            ownerMetadata,
            effectiveAccess: {
                v: 1,
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
            },
        });
        // Persist a projection actually admitted by the full reader, not a fabricated warm row.
        const { renderable: ownerRenderable, cache: cachedEntry } = await openOwnerRowFixture(row, credentials, encryption, accountCurrentness);
        const rendered: unknown[] = [];

        await fetchAndApplySessions({
            accountCurrentness,
            credentials,
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => Response.json({ sessions: [row], nextCursor: null, hasNext: false }),
            applySessions: () => {},
            applySessionListRenderables: (renderables) => rendered.push(...renderables),
            getExistingSession: () => null,
            getCurrentSessionListRenderable: () => ownerRenderable,
            cachedSessionListEntries: { s_locked: cachedEntry },
            log: { log: () => {} },
        });

        const first = rendered[0] as Parameters<typeof isUserFacingSession>[0] & { metadata?: unknown };
        expect(first.metadata).toMatchObject({ name: 'Owner title' });
        // The refresh renders the owner projection it already holds, so it must not hide the row.
        expect(isUserFacingSession(first)).toBe(true);
    });

    // A list refresh opens no key: it must not erase the content fact the hydrated Session holds.
    // Erased, the row reads as "encryption unknown", and an owner's untitled row flips to the locked
    // fallback until the next socket frame re-projects the Session (golden-journey-2 step 9).
    it.each(['ready', 'encrypted_content_unavailable'] as const)('keeps the hydrated Session content fact on a list refresh row (%s)', async (availability) => {
        const { buildSessionListRenderableFromCacheEntry } = await import('@/sync/domains/state/warmCacheAdapters');
        const contentKeys = tweetnacl.box.keyPair();
        const accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: contentKeys.secretKey, publicKey: contentKeys.publicKey });
        const credentials = {
            token: 't',
            encryption: {
                publicKey: encodeBase64(contentKeys.publicKey, 'base64'),
                machineKey: encodeBase64(contentKeys.secretKey, 'base64'),
            },
        } satisfies AuthCredentials;
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            ownerMetadata: { v: 1, workspace: { path: '/home/u/owner' } },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: contentKeys.publicKey,
            machineKey: contentKeys.secretKey,
        });
        const row = buildRow({
            metadataLayoutVersion: 1,
            metadata: await encryptOwnerSharedMetadata(encryption),
            ownerMetadata,
            effectiveAccess: {
                v: 1,
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
            },
        });
        const { session: opened } = await openOwnerRowFixture(row, credentials, encryption, accountCurrentness);
        const hydratedSession = { ...opened, encryptedContentAvailability: availability };
        // The row an earlier refresh wrote: it carries no content fact of its own.
        const previousRow = buildSessionListRenderableFromCacheEntry({
            sessionId: 's_locked',
            metadataLayoutVersion: 1,
            metadataVersion: 4,
            agentStateVersion: 5,
            updatedAt: 2,
            createdAt: 1,
            active: true,
            activeAt: 2,
            archivedAt: null,
            name: '',
            path: '/home/u/owner',
        });
        const rendered: unknown[] = [];

        await fetchAndApplySessions({
            accountCurrentness,
            credentials,
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => Response.json({ sessions: [row], nextCursor: null, hasNext: false }),
            applySessions: () => {},
            applySessionListRenderables: (renderables) => rendered.push(...renderables),
            getExistingSession: () => hydratedSession,
            getCurrentSessionListRenderable: () => previousRow,
            log: { log: () => {} },
        });

        expect(rendered[0]).toMatchObject({ encryptionMode: 'e2ee', encryptedContentAvailability: availability });
    });

    // A cold reload restores rows from the warm cache before any Session hydrates. The refresh row
    // must carry the settled fact persisted with its cached row, or an own readable Session reads
    // as "Encrypted session" until hydration.
    it('takes the content fact of a cold refresh row from its warm-cache row', async () => {
        const contentKeys = tweetnacl.box.keyPair();
        const accountCurrentness = createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: contentKeys.secretKey, publicKey: contentKeys.publicKey });
        const credentials = {
            token: 't',
            encryption: {
                publicKey: encodeBase64(contentKeys.publicKey, 'base64'),
                machineKey: encodeBase64(contentKeys.secretKey, 'base64'),
            },
        } satisfies AuthCredentials;
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            ownerMetadata: { v: 1, workspace: { path: '/home/u/owner' } },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: contentKeys.publicKey,
            machineKey: contentKeys.secretKey,
        });
        const row = buildRow({
            metadataLayoutVersion: 1,
            metadata: await encryptOwnerSharedMetadata(encryption),
            ownerMetadata,
            effectiveAccess: {
                v: 1,
                level: 'owner',
                sources: [{ kind: 'owner' }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
            },
        });
        const { cache: cachedEntry } = await openOwnerRowFixture(row, credentials, encryption, accountCurrentness);
        const rendered: unknown[] = [];

        await fetchAndApplySessions({
            accountCurrentness,
            credentials,
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => Response.json({ sessions: [row], nextCursor: null, hasNext: false }),
            applySessions: () => {},
            applySessionListRenderables: (renderables) => rendered.push(...renderables),
            getExistingSession: () => null,
            getCurrentSessionListRenderable: () => null,
            cachedSessionListEntries: { s_locked: cachedEntry },
            log: { log: () => {} },
        });

        expect(rendered[0]).toMatchObject({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'ready',
            metadataUnavailable: false,
            metadata: expect.objectContaining({ path: '/home/u/owner' }),
        });
        expect(isUserFacingSession(rendered[0] as Parameters<typeof isUserFacingSession>[0])).toBe(true);
    });

    it.each(['wrong_key', 'unsupported', 'null'] as const)('distinguishes metadata authentication from unsupported payloads (%s)', async (kind) => {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        const sessionKey = new Uint8Array(32).fill(8);
        const wrongWriter = await Encryption.create(secret);
        await wrongWriter.initializeSessions(new Map([['s_locked', kind === 'wrong_key' ? new Uint8Array(32).fill(9) : sessionKey]]));
        const ciphertext = await wrongWriter.getSessionEncryption('s_locked')!.encryptRaw(kind === 'null' ? null : false);
        const envelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionKey,
            recipientPublicKey: encryption.contentDataKey,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const applied: unknown[] = [];
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            credentials: { token: 't', secret: encodeBase64(secret, 'base64') },
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => sessionResponse(buildRow({
                dataEncryptionKey: encodeBase64(envelope, 'base64'),
                metadata: ciphertext,
            })),
            applySessions: (sessions) => applied.push(...sessions),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });
        if (kind === 'wrong_key') {
            expect(result.ok).toBe(true);
            expect(applied).toEqual([expect.objectContaining({
                id: 's_locked', metadata: null, encryptedContentAvailability: 'encrypted_content_unavailable',
            })]);
        } else {
            // An authenticated non-Metadata payload is not an opened full document.
            expect(result).toMatchObject({ ok: false, errorCode: 'stale_response', session: null });
            expect(applied).toEqual([]);
        }
        const snapshotApplied: Session[] = [];
        const displayed: unknown[] = [];
        await fetchAndApplySessions({
            credentials: { token: 't', secret: encodeBase64(secret, 'base64') },
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            encryption,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => Response.json({
                sessions: [buildRow({ dataEncryptionKey: encodeBase64(envelope, 'base64'), metadata: ciphertext })],
                nextCursor: null, hasNext: false,
            }),
            applySessions: (sessions) => snapshotApplied.push(...sessions),
            applySessionListRenderables: rows => displayed.push(...rows),
            requiredHydrationSessionIds: ['s_locked'],
            awaitSessionListHydration: true,
            log: { log: () => {} },
        });
        expect(snapshotApplied).toEqual([expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: kind === 'wrong_key' ? 'encrypted_content_unavailable' : 'ready',
        })]);
        // Authentication success alone cannot make an unsupported metadata body control-ready.
        expect(hasAuthoritativeSessionRouteData(snapshotApplied[0]))
            .toBe(kind === 'wrong_key');
        expect(displayed.at(-1)).toMatchObject({
            id: 's_locked',
            encryptedContentAvailability: kind === 'wrong_key' ? 'encrypted_content_unavailable' : 'ready',
        });
    });

    it('settles an authorized Session whose envelope has not arrived as pending, not as a failure', async () => {
        const encryption = createEncryption();
        const { result, applied } = await hydrateRow({
            row: buildRow({ share: { accessLevel: 'edit', canApprovePermissions: false } }),
            encryption,
        });

        expect(result.ok).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(encryption.decryptEncryptionKey).not.toHaveBeenCalled();
        expect(encryption.initializeSessions).not.toHaveBeenCalled();
        expect(applied).toEqual(expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: 'encrypted_access_pending',
        }));
    });

    it('settles a present envelope that will not open as repair and never falls back to account material', async () => {
        const encryption = createEncryption(() => null);
        const { result, applied } = await hydrateRow({
            row: buildRow({ dataEncryptionKey: 'unopenable-envelope' }),
            encryption,
        });

        expect(result.ok).toBe(true);
        expect(encryption.decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(encryption.initializeSessions).not.toHaveBeenCalled();
        expect(encryption.removeSessionEncryption).toHaveBeenCalledWith('s_locked');
        expect(applied).toEqual(expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: 'encrypted_access_needs_repair',
        }));
    });

    it('settles the first ready→locked refresh instead of rejecting its own clear', async () => {
        // The real generation owner is the point of this case: clearing a key the
        // request itself found unopenable advances the owning generation, and a
        // by-ID request must adopt that advance rather than read it as an Account
        // switch that invalidates its own truthful result.
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([['s_locked', new Uint8Array(32).fill(8)]]));
        expect(encryption.getSessionEncryption('s_locked')).not.toBeNull();

        const applied: unknown[] = [];
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked',
            accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: { token: 't', secret: encodeBase64(secret, 'base64') },
            encryption,
            sessionDataKeys: new Map([['s_locked', new Uint8Array(32).fill(8)]]),
            sessionDataKeyEnvelopes: new Map(),
            request: async () => sessionResponse(buildRow({
                dataEncryptionKey: 'unopenable-envelope',
                share: { accessLevel: 'view', canApprovePermissions: false },
            })),
            applySessions: (sessions) => applied.push(...sessions),
            log: { log: () => {} },
            includeTurnsProjection: false,
        });

        expect(result.errorCode).not.toBe('stale_response');
        expect(result.ok).toBe(true);
        expect(encryption.getSessionEncryption('s_locked')).toBeNull();
        expect(applied).toEqual([expect.objectContaining({
            id: 's_locked',
            metadata: null,
            encryptedContentAvailability: 'encrypted_access_needs_repair',
        })]);
    });

    it('keeps the owner-only account reader for a legacy-credential Session with no envelope', async () => {
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([['s_locked', null]]));
        const metadata = { path: '/retained/legacy', host: 'retained-host', name: 'Retained title' };
        const ciphertext = await encryption.getSessionEncryption('s_locked')!.encryptRaw(metadata);
        const decryptEncryptionKey = vi.spyOn(encryption, 'decryptEncryptionKey');
        const initializeSessions = vi.spyOn(encryption, 'initializeSessions');
        const applied: unknown[] = [];
        const result = await fetchAndApplySessionById({
            sessionId: 's_locked', accountCurrentness: E2EE_ACCOUNT_CURRENTNESS,
            credentials: { token: 't', secret: encodeBase64(secret) },
            encryption,
            sessionDataKeys: new Map(),
            request: async () => sessionResponse(buildRow({ metadata: ciphertext, share: null })),
            applySessions: sessions => applied.push(...sessions),
            includeTurnsProjection: false, log: { log() {} },
        });

        expect(result.ok).toBe(true);
        expect(decryptEncryptionKey).not.toHaveBeenCalled();
        expect([...(initializeSessions.mock.calls[0]?.[0] ?? new Map()).entries()])
            .toEqual([['s_locked', null]]);
        expect(applied).toEqual([expect.objectContaining({
            id: 's_locked',
            metadataLayoutVersion: 0,
            encryptedContentAvailability: 'ready',
            metadata: expect.objectContaining(metadata),
        })]);
        expect(hasAuthoritativeSessionRouteData(result.session)).toBe(true);
    });
});
