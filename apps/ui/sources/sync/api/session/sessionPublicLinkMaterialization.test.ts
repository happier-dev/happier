import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { executeSessionAccessHttpAction } from './sessionAccessApi';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { decryptDataKeyFromPublicShare } from '@/sync/encryption/publicShareEncryption';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

// Substitute native UI boundaries only; the default Action executor and its
// account-scoped Session HTTP dependency remain real.
installApprovalCommonModuleMocks({ storage: importOriginal => importOriginal() });

beforeAll(loadSyncSingletonForTests);

afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

describe.each(['plain', 'e2ee'] as const)('Session public-link physical materialization (%s)', mode => {
    it('privately delivers material on the selected Home and returns publication settings only', async () => {
        const active = await upsertAndActivateServer({ serverUrl: 'https://active-material.example', name: 'Active' });
        await switchConnectionToActiveServer();
        const target = await upsertServerProfile({ serverUrl: 'https://target-material.example', name: 'Target' });
        storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
        // As in the Artifact frontdoor fixture, this Home's Settings have
        // already been loaded by their real scoped store owner.
        storage.getState().applySettingsForScope(
            { serverId: target.id, accountId: 'target-account' }, storage.getState().settings, 1,
        );
        const contentKeys = tweetnacl.box.keyPair();
        const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({sub})).toString('base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => ({
            token: token(url === 'https://target-material.example' ? 'target-account' : 'active-account'),
            ...(mode === 'e2ee' ? { encryption: { publicKey: encodeBase64(contentKeys.publicKey, 'base64'), machineKey: encodeBase64(contentKeys.secretKey, 'base64') } } : {}),
        }));
        const dataKey = new Uint8Array(32).fill(31);
        const callerEnvelope = encryptDataKeyForRecipientV0(dataKey, encodeBase64(contentKeys.publicKey, 'base64'));
        const metadata = createSessionFixture().metadata;
        if (!metadata) throw new Error('Canonical Session fixture must include readable metadata');
        const currentSession = createPlainSessionCurrentProjectionRecordFixture({ id: 'same', metadata });
        if (currentSession.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical owner metadata fixture');
        const ownerMetadata = mode === 'e2ee' ? sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'dataKey', machineKey: contentKeys.secretKey },
            ownerMetadata: currentSession.ownerMetadata.v, randomBytes: tweetnacl.randomBytes,
        }) : currentSession.ownerMetadata;
        let wireMetadata = currentSession.metadata;
        if (mode === 'e2ee') {
            const [encryptedShared] = await new AES256Encryption(dataKey).encrypt([JSON.parse(currentSession.metadata)]);
            if (!encryptedShared) throw new Error('Expected encrypted Session shared metadata');
            wireMetadata = encodeBase64(encryptedShared, 'base64');
        }
        const accountCurrentness = mode === 'plain'
            ? createPlainAccountEncryptionCurrentnessFixture()
            : {
                mode: 'e2ee', version: 1, updatedAt: 1,
                signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey),
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(contentKeys.publicKey),
                recipientEnvelopeReadiness: { status: 'available' },
            } satisfies AccountEncryptionCurrentnessResponse;
        const session = SessionCurrentProjectionRecordV1Schema.parse({
            ...currentSession,
            seq: 0, active: true, activeAt: 2, updatedAt: 2,
            encryptionMode: mode, dataEncryptionKey: mode === 'e2ee' ? callerEnvelope : null,
            metadata: wireMetadata, ownerMetadata,
        });
        let body: Record<string, unknown> | null = null;
        let posts = 0;
        let legacyWrappedKey = 'existing-legacy-wrapped-key';
        let legacyPosts = 0;
        const physicalBodies: string[] = [];
        setRuntimeFetch(createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return new Response('{}');
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(accountCurrentness);
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v2/sessions/same') return Response.json({ session });
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            if (path === '/v1/sessions/same/public-share') {
                // The predecessor strips unknown fields and can update a
                // retained legacy publication without rotating its token hash.
                legacyPosts += 1;
                legacyWrappedKey = 'mutated-legacy-wrapped-key';
                return new Response(JSON.stringify({ publicShare: { id: 'legacy', expiresAt:null,maxUses:null,
                    useCount:0,isConsentRequired:false,updatedAt:2 } }));
            }
            if (path === '/v1/public-shares') {
                posts += 1;
                physicalBodies.push(String(init?.body));
                body = JSON.parse(String(init?.body));
                if (posts === 1) throw new TypeError('Response lost after dispatch');
                return new Response(JSON.stringify({publicShare:{id:'share',expiresAt:null,maxUses:null,useCount:0,
                    isConsentRequired:false,updatedAt:2,keyDerivation:'fragment_v1'},viewerOrigin:'https://target-material.example'}));
            }
            throw new Error(`Unexpected boundary request ${path}`);
        }));
        const issued: {lookupId:string;secret:string}[] = [];
        const result = await executeSessionAccessHttpAction({scope:{serverId:target.id,accountId:'target-account'},
            availability:'available',actionId:'session.public_link.create',input:{sessionId:'same',isConsentRequired:false},
            onPublicLinkIssued: async material => { await Promise.resolve(); issued.push(material); },
        });
        expect(issued).toHaveLength(1);
        expect(legacyPosts).toBe(0);
        expect(legacyWrappedKey).toBe('existing-legacy-wrapped-key');
        expect(posts).toBe(2);
        expect(physicalBodies[1]).toBe(physicalBodies[0]);
        expect(body).toMatchObject({subject:{kind:'session',id:'same'},lookupId:issued[0]!.lookupId,keyDerivation:'fragment_v1'});
        expect(body).not.toHaveProperty('sessionId');
        expect(body).not.toHaveProperty('token');
        expect(JSON.stringify(body)).not.toContain(issued[0]!.secret);
        expect(result).toMatchObject({ id: 'share', viewerOrigin: 'https://target-material.example' });
        expect(result).not.toHaveProperty('url');
        expect(JSON.stringify(result).includes(issued[0]!.secret)).toBe(false);
        if (mode === 'e2ee') {
            await expect(decryptDataKeyFromPublicShare(String(body!.encryptedDataKey),issued[0]!.secret)).resolves.toEqual(dataKey);
            await expect(decryptDataKeyFromPublicShare(String(body!.encryptedDataKey),issued[0]!.lookupId)).resolves.toBeNull();
        } else {
            expect(body).not.toHaveProperty('encryptedDataKey');
        }
        await expect(executeSessionAccessHttpAction({scope:{serverId:target.id,accountId:'target-account'},
            availability:'available',actionId:'session.public_link.create',input:{sessionId:'same',isConsentRequired:false},
            onPublicLinkIssued: async material => { await Promise.resolve(); throw new Error(material.secret); },
        })).rejects.toMatchObject({code:'outcome_unknown'});
        expect(posts).toBe(3);
        await expect(executeSessionAccessHttpAction({scope:{serverId:target.id,accountId:'target-account'},
            availability:'available',actionId:'session.public_link.create',input:{sessionId:'same',isConsentRequired:false},
        })).resolves.toHaveProperty('url');
        expect(posts).toBe(4);
        const privatelyIssued: import('@happier-dev/protocol/actions/executor/artifactPublicLinkActions').ArtifactPublicLinkIssuedV1[] = [];
        const actionResult = await createDefaultActionExecutor({ onPublicLinkIssued: async link => {
            await Promise.resolve();
            privatelyIssued.push(link);
        } }).execute('session.public_link.create',
            { sessionId: 'same', isConsentRequired: false }, {
                serverId: target.id, expectedAccountId: 'target-account', surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId: 'session.public_link.create' },
            });
        expect(actionResult, JSON.stringify(actionResult)).toMatchObject({ ok: true, result: {
            id: 'share',
        } });
        expect(JSON.stringify(actionResult).includes('#k=')).toBe(false);
        expect(actionResult).not.toHaveProperty('result.url');
        expect(privatelyIssued).toHaveLength(1);
        expect(privatelyIssued[0]).toMatchObject({ shareId: 'share', audience: 'anonymous' });
        expect(new URL(privatelyIssued[0]!.url).hash.length > 0).toBe(true);
        expect(posts).toBe(5);
    });
});
