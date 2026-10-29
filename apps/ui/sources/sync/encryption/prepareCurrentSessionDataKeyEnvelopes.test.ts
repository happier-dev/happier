import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type {
    PatchSessionDataKeyEnvelopesV1,
    SessionDataKeyEnvelopeItemV1,
    SessionDataKeyEnvelopePageV1,
    SessionDataKeyEnvelopeSummaryV1,
} from '@happier-dev/protocol';
import {
    SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    encodeSessionDataKeyEnvelopeCursorV1,
    openEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';

import {
    prepareCurrentSessionDataKeyEnvelopes,
    type CurrentSessionDataKeyEnvelopeTransport,
    type CurrentSessionPreparationScope,
} from './prepareCurrentSessionDataKeyEnvelopes';

const SERVER_ID = 'home-1';
const SESSION_ID = 'session-1';
const PAGE_MAX = SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1;

/** The one Session DEK this manager already opened locally; every envelope must carry exactly it. */
const SESSION_DATA_KEY = new Uint8Array(32).fill(7);

const scope: CurrentSessionPreparationScope = {
    session: { serverId: SERVER_ID, sessionId: SESSION_ID },
};

/** One content/signing key pair per recipient Account, so a substitution is actually detectable. */
const recipientKeys = new Map<string, {
    content: tweetnacl.BoxKeyPair;
    signing: tweetnacl.SignKeyPair;
}>();

function keysFor(accountId: string) {
    let existing = recipientKeys.get(accountId);
    if (!existing) {
        existing = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        recipientKeys.set(accountId, existing);
    }
    return existing;
}

/**
 * The exact wire encodings the shared recipient content-key contract uses: the Account signing key
 * is Hex, the content key and its signature are canonical Base64. `signedBy` lets one item advertise
 * an Account while the binding is signed by another key — the only substitution a client can detect.
 */
function availableItem(
    recipientAccountId: string,
    options?: Readonly<{
        envelopeState?: SessionDataKeyEnvelopeItemV1['envelopeState'];
        signedBy?: tweetnacl.SignKeyPair;
    }>,
): SessionDataKeyEnvelopeItemV1 {
    const keys = keysFor(recipientAccountId);
    return {
        recipientAccountId,
        envelopeState: options?.envelopeState ?? 'missing',
        contentKey: {
            status: 'available',
            accountSigningPublicKey: encodeHex(keys.signing.publicKey),
            contentPublicKey: encodeBase64(keys.content.publicKey, 'base64'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: (options?.signedBy ?? keys.signing).secretKey,
                contentPublicKey: keys.content.publicKey,
            }), 'base64'),
        },
    };
}

function unavailableItem(
    recipientAccountId: string,
    reason: 'plain_account' | 'encryption_setup_required' | 'encryption_inconsistent',
): SessionDataKeyEnvelopeItemV1 {
    return {
        recipientAccountId,
        envelopeState: 'missing',
        contentKey: { status: 'unavailable', reason },
    };
}

function summary(overrides?: Partial<SessionDataKeyEnvelopeSummaryV1>): SessionDataKeyEnvelopeSummaryV1 {
    return { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0, ...overrides };
}

function requiredPage(params: Readonly<{
    items: readonly SessionDataKeyEnvelopeItemV1[];
    nextCursor?: string | null;
    summary?: SessionDataKeyEnvelopeSummaryV1 | null;
}>): SessionDataKeyEnvelopePageV1 {
    return {
        status: 'required',
        summary: params.summary === undefined ? summary({ pending: params.items.length }) : params.summary,
        items: [...params.items],
        nextCursor: params.nextCursor ?? null,
    };
}


function createTransport(
    pages: ReadonlyArray<SessionDataKeyEnvelopePageV1>,
    appliedCount?: (request: PatchSessionDataKeyEnvelopesV1) => number,
) {
    let call = 0;
    const fetchPage = vi.fn(async (_cursor: string | null) => {
        const page = pages[Math.min(call, pages.length - 1)]!;
        call += 1;
        return page;
    });
    const patchPage = vi.fn(async (request: PatchSessionDataKeyEnvelopesV1) => ({
        appliedCount: appliedCount ? appliedCount(request) : request.entries.length,
    }));
    return { fetchPage, patchPage } satisfies CurrentSessionDataKeyEnvelopeTransport & {
        fetchPage: ReturnType<typeof vi.fn>;
        patchPage: ReturnType<typeof vi.fn>;
    };
}

/** Opens one uploaded envelope with the recipient's real secret key. */
function openAs(recipientAccountId: string, encryptedDataKey: string): Uint8Array | null {
    return openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(encryptedDataKey, 'base64'),
        recipientSecretKeyOrSeed: keysFor(recipientAccountId).content.secretKey,
    });
}

describe('prepareCurrentSessionDataKeyEnvelopes', () => {
    it('does not report a selected recipient repaired when it is no longer in the audience', async () => {
        const transport = createTransport([
            requiredPage({ items: [availableItem('another-account', { envelopeState: 'prepared' })] }),
        ]);
        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee', scope, transport,
            reprepareRecipientAccountId: 'removed-account',
            sessionDataKey: SESSION_DATA_KEY, isHostScopeCurrent: () => true,
        });
        expect(outcome).toMatchObject({ status: 'incomplete', preparedCount: 0 });
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('does not let targeted repair completion override a scope change after the write', async () => {
        let current = true;
        const transport = createTransport([
            requiredPage({ items: [availableItem('account-a', { envelopeState: 'prepared' })] }),
        ], request => { current = false; return request.entries.length; });
        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee', scope, transport,
            reprepareRecipientAccountId: 'account-a',
            sessionDataKey: SESSION_DATA_KEY, isHostScopeCurrent: () => current,
        });
        expect(outcome).toMatchObject({ status: 'scope_changed', preparedCount: 1 });
    });

    it('seals the one Session DEK to every pending recipient and commits the page once', async () => {
        const transport = createTransport([
            requiredPage({ items: [availableItem('account-a'), availableItem('account-b')] }),
            requiredPage({ items: [], summary: summary({ prepared: 2 }) }),
        ]);
        const onProgress = vi.fn();

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
            onProgress,
        });

        expect(outcome.status).toBe('complete');
        expect(outcome.preparedCount).toBe(2);
        expect(transport.patchPage).toHaveBeenCalledTimes(1);

        const request = transport.patchPage.mock.calls[0]![0] as PatchSessionDataKeyEnvelopesV1;
        expect(request.entries.map((entry) => entry.recipientAccountId)).toEqual(['account-a', 'account-b']);
        // Each recipient really recovers the exact Session DEK the manager holds — not a re-keyed
        // or per-recipient key, and not another Session's key.
        for (const entry of request.entries) {
            expect(openAs(entry.recipientAccountId, entry.encryptedDataKey)).toEqual(SESSION_DATA_KEY);
        }
        // A recipient cannot open another recipient's envelope.
        expect(openAs('account-b', request.entries[0]!.encryptedDataKey)).toBeNull();
        // The aggregate the Collaboration row renders is the server's, refreshed by the last page.
        expect(outcome.summary).toEqual(summary({ prepared: 2 }));
        expect(onProgress).toHaveBeenCalledWith({
            preparedCount: 2,
            pagesCommitted: 1,
            actionableTotal: 2,
        });
    });

    it('stops on a plain Session without key material or recipient discovery', async () => {
        const transport = createTransport([{ status: 'not_required' }]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'plain',
            scope,
            transport,
            sessionDataKey: null,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('not_required');
        expect(outcome.preparedCount).toBe(0);
        expect(transport.patchPage).not.toHaveBeenCalled();
        expect(transport.fetchPage).not.toHaveBeenCalled();
    });

    it('does not settle a plain Session as prepared once the captured scope changed', async () => {
        const transport = createTransport([{ status: 'not_required' }]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'plain',
            scope,
            transport,
            sessionDataKey: null,
            isHostScopeCurrent: () => false,
        });

        // The mode was read under the previous Home/Account; it cannot describe the current one.
        expect(outcome.status).toBe('scope_changed');
        expect(transport.fetchPage).not.toHaveBeenCalled();
    });

    it('refuses to start when this device holds no transferable standalone Session DEK', async () => {
        const transport = createTransport([requiredPage({ items: [availableItem('account-a')] })]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            // An Account-scoped fallback reader yields no standalone 32-byte Session key.
            sessionDataKey: null,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('session_data_key_unavailable');
        // Nothing is even discovered: no recipient identities are requested without usable material.
        expect(transport.fetchPage).not.toHaveBeenCalled();
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('rejects a wrong-length local key instead of sealing whatever bytes it was handed', async () => {
        const transport = createTransport([requiredPage({ items: [availableItem('account-a')] })]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: new Uint8Array(16).fill(7),
            isHostScopeCurrent: () => true,
        });

        expect(outcome.status).toBe('session_data_key_unavailable');
        expect(transport.fetchPage).not.toHaveBeenCalled();
    });

    it('skips a recipient whose Account cannot receive an envelope and still prepares the others', async () => {
        const transport = createTransport([
            requiredPage({
                items: [
                    unavailableItem('account-plain', 'plain_account'),
                    availableItem('account-b'),
                    unavailableItem('account-setup', 'encryption_setup_required'),
                ],
            }),
            requiredPage({ items: [] }),
        ]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
        });

        const request = transport.patchPage.mock.calls[0]![0] as PatchSessionDataKeyEnvelopesV1;
        expect(request.entries.map((entry) => entry.recipientAccountId)).toEqual(['account-b']);
        expect(outcome.preparedCount).toBe(1);
        expect(outcome.skippedCount).toBe(2);
        // Truthful per-recipient exception reasons for the Collaboration exception rows.
        expect(outcome.recipientsNeedingSetup).toEqual([
            { recipientAccountId: 'account-plain', reason: 'plain_account' },
            { recipientAccountId: 'account-setup', reason: 'encryption_setup_required' },
        ]);
        // A recipient that cannot receive a key is not a delivery failure of this Session.
        expect(outcome.invalidBindingRecipients).toEqual([]);
        expect(outcome.status).toBe('incomplete');
    });

    it('skips only the recipient whose content key its advertised Account did not sign', async () => {
        const forger = tweetnacl.sign.keyPair();
        const transport = createTransport([
            requiredPage({
                items: [availableItem('account-forged', { signedBy: forger }), availableItem('account-b')],
            }),
            requiredPage({ items: [] }),
        ]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
        });

        // Unlike the membership-history page, each item carries its own binding, so one substituted
        // binding must not withhold the Session key from every other authorized recipient.
        const request = transport.patchPage.mock.calls[0]![0] as PatchSessionDataKeyEnvelopesV1;
        expect(request.entries.map((entry) => entry.recipientAccountId)).toEqual(['account-b']);
        expect(outcome.invalidBindingRecipients).toEqual(['account-forged']);
        expect(outcome.skippedCount).toBe(1);
    });

    it('re-seals a structurally invalid tuple so Prepare again repairs it through the same PATCH', async () => {
        const transport = createTransport([
            requiredPage({
                items: [availableItem('account-a', { envelopeState: 'invalid' })],
                summary: summary({ invalid: 1 }),
            }),
            requiredPage({ items: [], summary: summary({ prepared: 1 }) }),
        ]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
        });

        const request = transport.patchPage.mock.calls[0]![0] as PatchSessionDataKeyEnvelopesV1;
        expect(request.entries).toHaveLength(1);
        expect(openAs('account-a', request.entries[0]!.encryptedDataKey)).toEqual(SESSION_DATA_KEY);
        expect(outcome.status).toBe('complete');
    });

    it('counts only what the server committed, not what it sealed locally', async () => {
        const transport = createTransport(
            [requiredPage({ items: [availableItem('account-a'), availableItem('account-b')] })],
            // A concurrent manager already prepared one of them.
            () => 1,
        );

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
        });

        expect(outcome.preparedCount).toBe(1);
    });

    it('suppresses the PATCH and progress when the captured scope changes while sealing', async () => {
        let hostScopeCurrent = true;
        // Two recipients at the lane chunk of 1 guarantee one real inter-chunk yield: a single-item
        // batch never releases the thread, so a one-recipient page could not exercise this at all.
        const transport = createTransport([
            requiredPage({ items: [availableItem('account-a'), availableItem('account-b')] }),
        ]);
        const onProgress = vi.fn();

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => hostScopeCurrent,
            onProgress,
            // The Home/account switch lands between cooperative sealing chunks.
            yieldBetweenChunks: async () => { hostScopeCurrent = false; },
        });

        expect(outcome.status).toBe('scope_changed');
        expect(transport.patchPage).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('abandons the commit when a real Account Encryption resets its generation mid-pass', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const contentKeys = tweetnacl.box.keyPair();
        // The canonical Account encryption owner itself, built the way data-key credentials build
        // it — its generation methods are the contract under test, not a stand-in for them.
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: contentKeys.publicKey,
            machineKey: contentKeys.secretKey,
        });
        await encryption.initializeSessions(
            new Map([[SESSION_ID, new Uint8Array(32).fill(1)]]),
            { serverId: SERVER_ID },
        );

        const transport = createTransport([
            requiredPage({ items: [availableItem('account-a'), availableItem('account-b')] }),
        ]);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
            encryption,
            sealChunkSize: 1,
            // A real re-key for this Session on this Home bumps the generation between cooperative
            // sealing chunks, which is the only moment a pass can seal against a retired key.
            yieldBetweenChunks: async () => {
                await encryption.initializeSessions(
                    new Map([[SESSION_ID, new Uint8Array(32).fill(2)]]),
                    { serverId: SERVER_ID },
                );
            },
        });

        expect(outcome.status).toBe('scope_changed');
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('pages a large audience within the atomic commit bound and settles on the final recheck', async () => {
        const total = PAGE_MAX * 2 + 3;
        const accountIds = Array.from({ length: total }, (_, index) => `account-${index + 1}`);
        const pages: SessionDataKeyEnvelopePageV1[] = [];
        for (let start = 0; start < total; start += PAGE_MAX) {
            const slice = accountIds.slice(start, start + PAGE_MAX);
            const isLast = start + PAGE_MAX >= total;
            pages.push(requiredPage({
                items: slice.map((accountId) => availableItem(accountId)),
                nextCursor: isLast ? null : encodeSessionDataKeyEnvelopeCursorV1(slice[slice.length - 1]!),
                summary: start === 0 ? summary({ pending: total }) : null,
            }));
        }
        pages.push(requiredPage({ items: [], summary: summary({ prepared: total }) }));
        const transport = createTransport(pages);

        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport,
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
            yieldBetweenChunks: async () => {},
        });

        expect(outcome.status).toBe('complete');
        expect(outcome.preparedCount).toBe(total);
        const expectedPages = Math.ceil(total / PAGE_MAX);
        expect(transport.patchPage).toHaveBeenCalledTimes(expectedPages);
        for (const [request] of transport.patchPage.mock.calls) {
            expect((request as PatchSessionDataKeyEnvelopesV1).entries.length).toBeLessThanOrEqual(PAGE_MAX);
        }
        expect(outcome.summary).toEqual(summary({ prepared: total }));
    });
    it('yields during binding verification even when every binding is invalid', async () => {
        const forger = tweetnacl.sign.keyPair();
        const transport = createTransport([requiredPage({ items: [
            availableItem('invalid-a', { signedBy: forger }),
            availableItem('invalid-b', { signedBy: forger }),
        ] })]);
        let yields = 0;
        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope, transport, sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => true,
            sealChunkSize: 1,
            yieldBetweenChunks: async () => { yields += 1; },
        });
        expect(yields).toBeGreaterThan(0);
        expect(outcome.invalidBindingRecipients).toEqual(['invalid-a', 'invalid-b']);
        expect(transport.patchPage).not.toHaveBeenCalled();
    });

    it('does not replace scope cancellation with a stale plain-session response', async () => {
        let current = true;
        const outcome = await prepareCurrentSessionDataKeyEnvelopes({
            sessionEncryptionMode: 'e2ee',
            scope,
            transport: {
                fetchPage: async () => { current = false; return { status: 'not_required' }; },
                patchPage: async () => { throw new Error('unexpected PATCH'); },
            },
            sessionDataKey: SESSION_DATA_KEY,
            isHostScopeCurrent: () => current,
        });
        expect(outcome.status).toBe('scope_changed');
    });

});
