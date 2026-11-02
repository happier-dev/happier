import { beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type {
    MembershipSessionDataKeyEnvelopePageV1,
    PatchMembershipSessionDataKeyEnvelopesV1,
} from '@happier-dev/protocol';
import {
    encodeMembershipSessionDataKeyEnvelopeCursorV1,
    SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';

import {
    prepareMembershipHistorySessionDataKeyEnvelopes,
    type MembershipHistoryPreparationScope,
    type MembershipSessionDataKeyEnvelopeTransport,
} from './prepareMembershipHistorySessionDataKeyEnvelopes';
import { Encryption } from './encryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import { SESSION_DATA_KEY_SEAL_CHUNK_SIZE } from './directShareEncryption';
import { DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE } from './cryptoBatchYield';
import { AES256Encryption } from './encryptor';

const SERVER_ID = 'home-1';
const RECIPIENT_ACCOUNT_ID = 'account-recipient';
/** The server's atomic page/commit bound. It is a transport bound, never a local crypto budget. */
const PAGE_MAX = SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1;

const callerContentKeyPair = tweetnacl.box.keyPair();
const recipientContentKeyPair = tweetnacl.box.keyPair();
const recipientSigningKeyPair = tweetnacl.sign.keyPair();
const otherSigningKeyPair = tweetnacl.sign.keyPair();

const scope: MembershipHistoryPreparationScope = {
    serverId: SERVER_ID,
    recipientAccountId: RECIPIENT_ACCOUNT_ID,
};

function dataKeyFor(seed: number): Uint8Array {
    return new Uint8Array(32).fill(seed);
}

/** The caller's own canonical Session envelope, exactly as the historical GET returns it. */
function callerEnvelopeFor(seed: number): string {
    return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
/**
 * Each Session's own strict layout-1 shared metadata sealed with its key, which is what proves to
 * the pass that the key the Home names is that Session's. `dataKeyFor` wraps at one byte, so one
 * ciphertext per byte value covers every seed.
 */
const boundMetadataByKeyByte = new Map<number, string>();
beforeAll(async () => {
    for (let byte = 0; byte < 256; byte += 1) {
        const [sealed] = await new AES256Encryption(new Uint8Array(32).fill(byte)).encrypt([{ v: 1 }]);
        boundMetadataByKeyByte.set(byte, encodeBase64(sealed!, 'base64'));
    }
});

        dataKey: dataKeyFor(seed),
        recipientPublicKey: callerContentKeyPair.publicKey,
        randomBytes: (length) => tweetnacl.randomBytes(length),
    }), 'base64');
}

/**
 * The exact wire encodings the shared recipient content-key contract uses: the Account signing key
 * is Hex, the content key and its signature are canonical Base64. `signedBy` lets a test sign with
 * a key other than the advertised one, which is the only forgery the client can actually detect.
 */
function contentKeyBinding(signedBy: tweetnacl.SignKeyPair = recipientSigningKeyPair) {
    return {
        status: 'available' as const,
        accountSigningPublicKey: encodeHex(recipientSigningKeyPair.publicKey),
        contentPublicKey: encodeBase64(recipientContentKeyPair.publicKey, 'base64'),
        contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
            accountSigningSecretKey: signedBy.secretKey,
            contentPublicKey: recipientContentKeyPair.publicKey,
        }), 'base64'),
    };
}

function readyPage(params: Readonly<{
    sessionSeeds: readonly number[];
    nextCursor?: string | null;
    recipientAccountId?: string;
    signedBy?: tweetnacl.SignKeyPair;
    exceptions?: Extract<MembershipSessionDataKeyEnvelopePageV1, { status: 'ready' }>['exceptions'];
}>): MembershipSessionDataKeyEnvelopePageV1 {
    return {
        status: 'ready',
        recipientAccountId: params.recipientAccountId ?? RECIPIENT_ACCOUNT_ID,
        contentKey: contentKeyBinding(params.signedBy),
        items: params.sessionSeeds.map((seed) => ({
            sessionId: `session-${seed}`,
            callerDataKeyEnvelope: callerEnvelopeFor(seed),
        })),
        exceptions: params.exceptions === undefined ? {
            callerVisibleNonTransferableSessionCount: 0,
            metadata: boundMetadataByKeyByte.get(seed & 0xff)!,
            metadataLayoutVersion: 1,
            callerEnvelopeRepairRequiredCount: 0,
        } : params.exceptions,
        nextCursor: params.nextCursor ?? null,
    };
}

/** Fault injection lives at the native-worker boundary; Account batch opening stays real. */
async function createEncryption(
    overrides?: (envelope: string, index: number) => Uint8Array | null | undefined,
) {
    const encryption = await Encryption.createFromContentKeyPair({
        publicKey: callerContentKeyPair.publicKey,
        machineKey: callerContentKeyPair.secretKey,
    });
    if (overrides) {
        const worker = createFakeCryptoWorker();
        encryption.configureNativeCryptoWorker({ routing: { mode: 'require', minPayloadBytes: 0 }, worker: {
            ...worker,
            decryptDataKeyEnvelopeV1: async (request) => {
                const result = await worker.decryptDataKeyEnvelopeV1(request);
                if (result.status !== 'ok') return result;
                return { ...result, items: result.items.map((value, index) => {
                    const replacement = overrides('', index);
                    return replacement === undefined ? value : replacement === null ? null : encodeBase64(replacement, 'base64');
                }) };
            },
        } });
    }
    const decryptEncryptionKeys = vi.spyOn(encryption, 'decryptEncryptionKeys');
    return Object.assign(encryption, { decryptEncryptionKeys });
}

function createTransport(
    pages: ReadonlyArray<MembershipSessionDataKeyEnvelopePageV1>,
    appliedCount?: (request: PatchMembershipSessionDataKeyEnvelopesV1) => number,
) {
    let call = 0;
    const fetchPage = vi.fn(async (_cursor: string | null) => {
        const page = pages[Math.min(call, pages.length - 1)]!;
        call += 1;
        return page;
    });
    const patchPage = vi.fn(async (request: PatchMembershipSessionDataKeyEnvelopesV1) => ({
        appliedCount: appliedCount ? appliedCount(request) : request.entries.length,
    }));
    return { fetchPage, patchPage } satisfies MembershipSessionDataKeyEnvelopeTransport & {
        fetchPage: ReturnType<typeof vi.fn>;
        patchPage: ReturnType<typeof vi.fn>;
    };
}

describe('prepareMembershipHistorySessionDataKeyEnvelopes', () => {
    it('opens the caller envelopes in one cold-cache batch and seals the same DEK to the target', async () => {
        const transport = createTransport([readyPage({ sessionSeeds: [1, 2, 3] }), readyPage({ sessionSeeds: [] })]);
        const encryption = await createEncryption();
        const onProgress = vi.fn();

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
            onProgress,
        });

        expect(outcome.status).toBe('complete');
        expect(outcome.preparedCount).toBe(3);
        // The work page plus the one final action-required recheck that lets the pass conclude its
        // own committed work settled. The empty recheck costs no second batched open:
        // never one request or one open call per Session.
        expect(transport.fetchPage).toHaveBeenCalledTimes(2);
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(encryption.decryptEncryptionKeys.mock.calls[0]![0]).toHaveLength(3);

        const request = transport.patchPage.mock.calls[0]![0] as PatchMembershipSessionDataKeyEnvelopesV1;
        // The top-level echo is what protects a provider reset from receiving the old Account's bytes.
        expect(request.recipientAccountId).toBe(RECIPIENT_ACCOUNT_ID);
        expect(request.entries.map((entry) => entry.sessionId)).toEqual(['session-1', 'session-2', 'session-3']);
        // The recipient really recovers the same Session DEK from the uploaded envelope.
        for (const entry of request.entries) {
            const seed = Number(entry.sessionId.slice('session-'.length));
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(entry.encryptedDataKey, 'base64'),
                recipientSecretKeyOrSeed: recipientContentKeyPair.secretKey,
            })).toEqual(dataKeyFor(seed));
        }
        expect(onProgress).toHaveBeenCalledWith({ preparedCount: 3, pagesCommitted: 1 });
    });

    it('counts only what the server committed', async () => {
        const transport = createTransport([readyPage({ sessionSeeds: [1, 2, 3] })], () => 2);

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption: await createEncryption(),
            isHostScopeCurrent: () => true,
        });

        expect(outcome.preparedCount).toBe(2);
    });

    it('stops on an unavailable recipient without opening or sealing anything', async () => {
        const transport = createTransport([{
            status: 'recipient_unavailable',
            recipientAccountId: RECIPIENT_ACCOUNT_ID,
            contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
        }]);
        const encryption = await createEncryption();

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('recipient_unavailable');
        expect(outcome.recipientUnavailableReason).toBe('encryption_setup_required');
        expect(encryption.decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('refuses to seal against a content key the advertised Account did not sign', async () => {
        const transport = createTransport([
            // The page still advertises the recipient's signing key, but the binding was signed by
            // another key: only the signature can expose that substitution.
            readyPage({ sessionSeeds: [1], signedBy: otherSigningKeyPair }),
        ]);
        const encryption = await createEncryption();

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('invalid_recipient_binding');
        expect(encryption.decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('rejects a page whose target Account no longer matches the captured recipient', async () => {
        const transport = createTransport([
            readyPage({ sessionSeeds: [1], recipientAccountId: 'account-replacement' }),
        ]);

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption: await createEncryption(),
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('recipient_changed');
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('reports an unopenable caller envelope as repair work instead of guessing a key', async () => {
        const transport = createTransport([
            readyPage({ sessionSeeds: [1, 2], nextCursor: 'membership_data_key_cursor_v1_session-2' }),
            readyPage({ sessionSeeds: [] }),
            readyPage({ sessionSeeds: [1] }),
        ]);
        // Session 1's caller envelope cannot be opened on this device.
        const encryption = await createEncryption((_envelope, index) => (index === 0 ? null : undefined));

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('incomplete');
        expect(outcome.preparedCount).toBe(1);
        expect(outcome.skippedCount).toBe(1);
        // Qualified with the captured Home so cross-Home Session ids can never collide.
        expect(outcome.repairRequiredSessions).toEqual([{ serverId: SERVER_ID, sessionId: 'session-1' }]);
        const request = transport.patchPage.mock.calls[0]![0] as PatchMembershipSessionDataKeyEnvelopesV1;
        expect(request.entries.map((entry) => entry.sessionId)).toEqual(['session-2']);
        // The pass is finite: the failed Session is not opened again on the first-page recheck.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
    });

    it('treats a wrong-length opened key as repair work rather than sealing it', async () => {
        const transport = createTransport([readyPage({ sessionSeeds: [1] })]);
        const encryption = await createEncryption(() => new Uint8Array(16));

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.skippedCount).toBe(1);
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('suppresses the PATCH and progress when the host scope changes while sealing', async () => {
        let hostScopeCurrent = true;
        const transport = createTransport([readyPage({ sessionSeeds: [1, 2] })]);
        const encryption = await createEncryption((_envelope, index) => {
            if (index === 0) hostScopeCurrent = false;
            return undefined;
        });
        const onProgress = vi.fn();

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => hostScopeCurrent,
            onProgress,
        });

        expect(outcome.status).toBe('scope_changed');
        expect(transport.patchPage).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('seals a full page with the measured lane chunk rather than the generic batch default', async () => {
        const seeds = Array.from({ length: PAGE_MAX }, (_, index) => index + 1);
        const transport = createTransport([readyPage({ sessionSeeds: seeds }), readyPage({ sessionSeeds: [] })]);
        let yields = 0;

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption: await createEncryption(),
            isHostScopeCurrent: () => true,
            yieldBetweenChunks: async () => { yields += 1; },
        });

        expect(outcome.preparedCount).toBe(PAGE_MAX);
        // The measured lane chunk releases the thread between individual seals. The generic default
        // of 32 would swallow a whole 24-entry page into one uninterrupted slice and yield zero
        // times, which is the regression this guards.
        expect(SESSION_DATA_KEY_SEAL_CHUNK_SIZE).toBeLessThan(DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE);
        expect(yields).toBe(Math.ceil(PAGE_MAX / SESSION_DATA_KEY_SEAL_CHUNK_SIZE) - 1);
    });

    it('walks 500 eligible Sessions in protocol-bounded pages, committing each page once', async () => {
        const total = 500;
        const pages = [];
        for (let start = 0; start < total; start += PAGE_MAX) {
            const seeds = Array.from(
                { length: Math.min(PAGE_MAX, total - start) },
                (_, index) => start + index + 1,
            );
            const isLast = start + PAGE_MAX >= total;
            pages.push(readyPage({
                sessionSeeds: seeds,
                nextCursor: isLast ? null : encodeMembershipSessionDataKeyEnvelopeCursorV1(`session-${start + seeds.length}`),
                exceptions: start === 0 ? {
                    callerVisibleNonTransferableSessionCount: 2,
                    callerEnvelopeRepairRequiredCount: 1,
                } : null,
            }));
        }
        // The one final action-required recheck finds the whole history settled.
        pages.push(readyPage({
            sessionSeeds: [],
            exceptions: {
                callerVisibleNonTransferableSessionCount: 3,
                callerEnvelopeRepairRequiredCount: 2,
            },
        }));
        const transport = createTransport(pages);
        const encryption = await createEncryption();

        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope,
            transport,
            encryption,
            isHostScopeCurrent: () => true,
            yieldBetweenChunks: async () => {},
        });

        expect(outcome.status).toBe('complete');
        expect(outcome.preparedCount).toBe(total);
        expect(outcome.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 3,
            callerEnvelopeRepairRequiredCount: 2,
        });
        const expectedPages = Math.ceil(total / PAGE_MAX);
        // One batched open and one atomic commit per page: never one request per Session, and
        // never a commit wider than the server's atomic bound.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(expectedPages);
        expect(transport.patchPage).toHaveBeenCalledTimes(expectedPages);
        for (const [request] of transport.patchPage.mock.calls) {
            expect((request as PatchMembershipSessionDataKeyEnvelopesV1).entries.length)
                .toBeLessThanOrEqual(PAGE_MAX);
        }
    });
    it('does not replace scope cancellation with stale recipient setup status', async () => {
        let current = true;
        const encryption = await createEncryption();
        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope, encryption,
            transport: {
                fetchPage: async () => {
                    current = false;
                    return {
                        status: 'recipient_unavailable',
                        recipientAccountId: RECIPIENT_ACCOUNT_ID,
                        contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
                    };
                },
                patchPage: async () => { throw new Error('unexpected PATCH'); },
            },
            isHostScopeCurrent: () => current,
        });
        expect(outcome.status).toBe('scope_changed');
        expect(outcome.recipientUnavailableReason).toBeNull();
        expect(encryption.decryptEncryptionKeys).not.toHaveBeenCalled();
    });

    it('stops discovery on recipient setup failure after a committed page', async () => {
        const transport = createTransport([
            readyPage({ sessionSeeds: [1], nextCursor: 'next' }),
            { status: 'recipient_unavailable', recipientAccountId: RECIPIENT_ACCOUNT_ID,
                contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } },
            readyPage({ sessionSeeds: [2] }),
        ]);
        const outcome = await prepareMembershipHistorySessionDataKeyEnvelopes({
            scope, transport, encryption: await createEncryption(), isHostScopeCurrent: () => true,
        });
        expect(outcome.status).toBe('recipient_unavailable');
        expect(outcome.preparedCount).toBe(1);
        expect(transport.fetchPage).toHaveBeenCalledTimes(2);
        expect(transport.patchPage).toHaveBeenCalledTimes(1);
    });

});
