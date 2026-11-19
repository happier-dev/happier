import { describe, expect, it, vi } from 'vitest';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    readSessionDataKeyCredentialKind,
    resolveSessionDataKeyViewerRole,
    type SessionDataKeyHydrationEncryption,
} from './sessionDataKeyHydration';

/**
 * Envelope opens reach the crypto routing layer as a single batch to amortize
 * dispatch overhead while preserving the Session-to-key mapping.
 */
function createEncryption(
    decryptEncryptionKeys: SessionDataKeyHydrationEncryption['decryptEncryptionKeys'],
): SessionDataKeyHydrationEncryption {
    return { decryptEncryptionKeys };
}

function keyFor(seed: number): Uint8Array {
    return new Uint8Array(32).fill(seed);
}

async function hydrate(params: Readonly<{
    sessions: Parameters<typeof createSessionDataKeyHydrationPlan>[0]['sessions'];
    credentialKind: Parameters<typeof createSessionDataKeyHydrationPlan>[0]['credentialKind'];
    encryption: SessionDataKeyHydrationEncryption;
    sessionDataKeys?: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
}>) {
    const sessionDataKeys = params.sessionDataKeys ?? new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = params.sessionDataKeyEnvelopes ?? new Map<string, string>();
    const plan = createSessionDataKeyHydrationPlan({
        sessions: params.sessions,
        credentialKind: params.credentialKind,
        sessionDataKeys,
        sessionDataKeyEnvelopes,
    });
    const result = await hydrateSessionDataKeys({
        plan,
        encryption: params.encryption,
        sessionDataKeys,
        sessionDataKeyEnvelopes,
    });
    return { plan, result, sessionDataKeys, sessionDataKeyEnvelopes };
}

describe('hydrateSessionDataKeys', () => {
    it('opens every uncached envelope in a single batched call', async () => {
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) =>
            values.map((value) => keyFor(Number(value.slice('envelope-'.length)))),
        );
        const sessions = Array.from({ length: 12 }, (_, index) => ({
            id: `session-${index}`,
            encryptionMode: 'e2ee',
            dataEncryptionKey: `envelope-${index}`,
        }));

        const { result } = await hydrate({
            sessions,
            credentialKind: 'data_key',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(decryptEncryptionKeys.mock.calls[0]![0]).toHaveLength(sessions.length);
        expect(result.sessionKeys.size).toBe(sessions.length);
        expect(result.sessionKeys.get('session-7')).toEqual(keyFor(7));
        expect(result.states.get('session-7')).toBe('ready');
    });

    it('excludes cached-envelope hits and plain rows from the batch while keeping their keys', async () => {
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => values.map(() => keyFor(9)));
        const cachedKey = keyFor(1);

        const { result } = await hydrate({
            sessions: [
                { id: 'cached', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-cached' },
                { id: 'plain', encryptionMode: 'plain', dataEncryptionKey: null },
                { id: 'fresh', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-fresh' },
            ],
            credentialKind: 'data_key',
            encryption: createEncryption(decryptEncryptionKeys),
            sessionDataKeys: new Map([['cached', cachedKey]]),
            sessionDataKeyEnvelopes: new Map([['cached', 'envelope-cached']]),
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(decryptEncryptionKeys.mock.calls[0]![0]).toEqual(['envelope-fresh']);
        expect(result.sessionKeys.get('cached')).toBe(cachedKey);
        expect(result.sessionKeys.has('plain')).toBe(false);
        expect(result.sessionKeys.get('fresh')).toEqual(keyFor(9));
        expect(result.states.get('cached')).toBe('ready');
        expect(result.states.get('plain')).toBe('not_required');
        expect(result.states.get('fresh')).toBe('ready');
    });

    it('does not call the crypto layer at all when nothing needs opening', async () => {
        const decryptEncryptionKeys = vi.fn(async () => []);

        const { result } = await hydrate({
            sessions: [{ id: 'plain', encryptionMode: 'plain', dataEncryptionKey: null }],
            credentialKind: 'keyless',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(result.states.get('plain')).toBe('not_required');
    });
});

describe('sessionDataKeyHydration owner-only absent-envelope compatibility', () => {
    it('keeps the account-secret reader for a legacy-credential owner Session with no envelope', async () => {
        const decryptEncryptionKeys = vi.fn(async () => []);

        const { result } = await hydrate({
            sessions: [{ id: 'legacy-owner', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }],
            credentialKind: 'legacy_secret',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(result.states.get('legacy-owner')).toBe('legacy_fallback_ready');
        // A `null` session key is the existing Account-scoped fallback reader request.
        expect(result.sessionKeys.has('legacy-owner')).toBe(true);
        expect(result.sessionKeys.get('legacy-owner')).toBeNull();
        expect(result.sessionEncryptionClears).not.toContain('legacy-owner');
    });

    it('keeps the incumbent account-scoped reader for a data-key owner Session with a genuinely absent envelope', async () => {
        const { result } = await hydrate({
            sessions: [{ id: 'datakey-owner', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }],
            credentialKind: 'data_key',
            encryption: createEncryption(async () => []),
        });

        expect(result.states.get('datakey-owner')).toBe('legacy_fallback_ready');
        expect(result.sessionKeys.get('datakey-owner')).toBeNull();
        expect(result.sessionEncryptionClears).not.toContain('datakey-owner');
    });

    it('never fabricates a fallback reader for a keyless owner Session', async () => {
        const { result } = await hydrate({
            sessions: [{ id: 'keyless-owner', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null }],
            credentialKind: 'keyless',
            encryption: createEncryption(async () => []),
        });

        expect(result.states.get('keyless-owner')).toBe('missing_envelope');
        expect(result.sessionKeys.has('keyless-owner')).toBe(false);
        expect(result.sessionEncryptionClears).toContain('keyless-owner');
    });

    it('never gives a non-owner the account fallback when the envelope is absent', async () => {
        const { result } = await hydrate({
            sessions: [{
                id: 'shared',
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                share: { accessLevel: 'edit' },
            }],
            credentialKind: 'data_key',
            encryption: createEncryption(async () => []),
        });

        expect(result.states.get('shared')).toBe('missing_envelope');
        expect(result.sessionKeys.has('shared')).toBe(false);
        expect(result.sessionEncryptionClears).toContain('shared');
    });

    it('prefers an explicit normalized viewer role over released share inference', async () => {
        const { result } = await hydrate({
            sessions: [{
                id: 'marked-recipient',
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
                share: null,
                viewerRole: 'recipient',
            }],
            credentialKind: 'legacy_secret',
            encryption: createEncryption(async () => []),
        });

        expect(result.states.get('marked-recipient')).toBe('missing_envelope');
        expect(result.sessionKeys.has('marked-recipient')).toBe(false);
    });
});

describe('sessionDataKeyHydration present-envelope failures', () => {
    it('never reuses a cached key after the current credential becomes keyless', async () => {
        const sessionDataKeys = new Map([['keyless', keyFor(3)]]);
        const sessionDataKeyEnvelopes = new Map([['keyless', 'envelope-current']]);
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) =>
            values.map(() => null),
        );

        const { result } = await hydrate({
            sessions: [{
                id: 'keyless',
                encryptionMode: 'e2ee',
                dataEncryptionKey: 'envelope-current',
                viewerRole: 'recipient',
            }],
            credentialKind: 'keyless',
            encryption: createEncryption(decryptEncryptionKeys),
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledWith(
            ['envelope-current'],
            {},
        );
        expect(result.states.get('keyless')).toBe('unopenable_envelope');
        expect(sessionDataKeys.has('keyless')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('keyless')).toBe(false);
    });

    it('settles a failed open as unopenable instead of retrying the account key', async () => {
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => values.map(() => null));

        const { result } = await hydrate({
            sessions: [{ id: 'owned', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-owned', share: null }],
            credentialKind: 'legacy_secret',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(result.states.get('owned')).toBe('unopenable_envelope');
        expect(result.sessionKeys.has('owned')).toBe(false);
        expect(result.sessionEncryptionClears).toContain('owned');
    });

    it('rejects wrong-length opened and cached keys as unopenable envelopes', async () => {
        const sessionDataKeys = new Map([['wrong-length-cached', new Uint8Array(31).fill(4)]]);
        const sessionDataKeyEnvelopes = new Map([['wrong-length-cached', 'envelope-cached']]);
        const { result } = await hydrate({
            sessions: [
                {
                    id: 'wrong-length-opened',
                    encryptionMode: 'e2ee',
                    dataEncryptionKey: 'envelope-current',
                    viewerRole: 'recipient',
                },
                {
                    id: 'wrong-length-cached',
                    encryptionMode: 'e2ee',
                    dataEncryptionKey: 'envelope-cached',
                    viewerRole: 'recipient',
                },
            ],
            credentialKind: 'data_key',
            encryption: createEncryption(async () => [new Uint8Array(31).fill(7)]),
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(result.states.get('wrong-length-opened')).toBe('unopenable_envelope');
        expect(result.states.get('wrong-length-cached')).toBe('unopenable_envelope');
        expect(result.sessionKeys.has('wrong-length-opened')).toBe(false);
        expect(result.sessionKeys.has('wrong-length-cached')).toBe(false);
        expect(result.sessionEncryptionClears).toEqual(
            expect.arrayContaining(['wrong-length-opened', 'wrong-length-cached']),
        );
        expect(sessionDataKeys.has('wrong-length-cached')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('wrong-length-cached')).toBe(false);
    });

    it('rejects a malformed present envelope without attempting any open or fallback', async () => {
        const decryptEncryptionKeys = vi.fn(async () => []);

        const { result } = await hydrate({
            sessions: [{
                id: 'malformed',
                encryptionMode: 'e2ee',
                dataEncryptionKey: { bytes: 'not-a-string' },
                share: null,
            }],
            credentialKind: 'legacy_secret',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(result.states.get('malformed')).toBe('unopenable_envelope');
        expect(result.sessionKeys.has('malformed')).toBe(false);
        expect(result.sessionEncryptionClears).toContain('malformed');
    });

    it('treats an empty-string envelope as present-and-malformed, never as absence', async () => {
        const decryptEncryptionKeys = vi.fn(async () => []);

        const { result } = await hydrate({
            sessions: [{ id: 'empty-owner', encryptionMode: 'e2ee', dataEncryptionKey: '', share: null }],
            credentialKind: 'data_key',
            encryption: createEncryption(decryptEncryptionKeys),
        });

        // The column carried a value, so it is not the genuinely absent envelope that section 13.3
        // allows an owner to read with Account-scoped material. Falling back here would silently
        // open a corrupted Session with the wrong reader instead of asking for repair.
        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
        expect(result.states.get('empty-owner')).toBe('unopenable_envelope');
        expect(result.sessionKeys.has('empty-owner')).toBe(false);
        expect(result.sessionEncryptionClears).toContain('empty-owner');
    });

    it('drops a stale cached key when the envelope becomes unopenable', async () => {
        const sessionDataKeys = new Map([['rotated', keyFor(3)]]);
        const sessionDataKeyEnvelopes = new Map([['rotated', 'envelope-old']]);

        const { result } = await hydrate({
            sessions: [{ id: 'rotated', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-new', share: null }],
            credentialKind: 'data_key',
            encryption: createEncryption(async (values) => values.map(() => null)),
            sessionDataKeys,
            sessionDataKeyEnvelopes,
        });

        expect(result.states.get('rotated')).toBe('unopenable_envelope');
        expect(sessionDataKeys.has('rotated')).toBe(false);
        expect(sessionDataKeyEnvelopes.has('rotated')).toBe(false);
    });
});

describe('sessionDataKeyHydration inputs', () => {
    it('reads the credential kind actually held by this device', () => {
        expect(readSessionDataKeyCredentialKind({ token: 't' })).toBe('keyless');
        expect(readSessionDataKeyCredentialKind({ token: 't', secret: 's' })).toBe('legacy_secret');
        expect(readSessionDataKeyCredentialKind({
            token: 't',
            encryption: { publicKey: 'p', machineKey: 'm' },
        })).toBe('data_key');
        expect(readSessionDataKeyCredentialKind(null)).toBe('keyless');
    });

    it('treats a present share as recipient authority and absent share as owner', () => {
        expect(resolveSessionDataKeyViewerRole({ share: null })).toBe('owner');
        expect(resolveSessionDataKeyViewerRole({ share: undefined })).toBe('owner');
        expect(resolveSessionDataKeyViewerRole({ share: { accessLevel: 'view' } })).toBe('recipient');
        expect(resolveSessionDataKeyViewerRole({ share: null, viewerRole: 'recipient' })).toBe('recipient');
    });

    it('uses current normalized access before the released share fallback and fails malformed current closed', () => {
        expect(resolveSessionDataKeyViewerRole({
            share: null,
            effectiveAccess: {
                v: 1,
                level: 'view',
                sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
                primaryTeamId: 'team-1',
            },
        })).toBe('recipient');
        expect(resolveSessionDataKeyViewerRole({
            share: null,
            effectiveAccess: { v: 1, level: 'owner' },
        })).toBe('recipient');
    });
});
