import { describe, expect, it } from 'vitest';

import {
    createSessionOwnerMetadataV1,
    projectSessionOwnerCompatibilityViewV1,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol';

import { getSessionStorageKind, resolveSessionStorageAuthority } from './sessionStorageKind';

const VALID_LINK = {
    v: 1 as const,
    agentId: 'codex',
    machineId: 'machine-source',
    remoteSessionId: 'remote-1',
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

function layoutZero(metadata: Record<string, unknown>) {
    return { metadata, metadataLayoutVersion: 0 };
}

function layoutOne(metadata: Record<string, unknown>, options?: { projected: boolean }) {
    const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
    if (!ownerMetadata.ok) throw new Error('owner metadata projection failed');
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata });
    return {
        metadata: sharedMetadata,
        metadataLayoutVersion: 1,
        ...(options?.projected === false
            ? {}
            : {
                // Exactly what the sync engine stores on a layout-1 row.
                ownerMetadataView: projectSessionOwnerCompatibilityViewV1({
                    sharedMetadata,
                    ownerMetadata: ownerMetadata.ownerMetadata,
                }),
            }),
    };
}

/**
 * `sessionStorageKind` answers one question for the whole client: does this
 * Session's transcript live with an external Agent, or with us?
 *
 * Presentation may guess. The handoff producer may NOT: it stamps
 * `sessionStorageMode` on the RPC that stops the source and
 * `sourceSessionStorageMode` on the prepare request the TARGET daemon uses to
 * choose which storage to import into. The nullable read this authority
 * replaced answered `persisted` for three different facts — no link, a link
 * that cannot be parsed, and an owner projection this device has not received
 * — so a genuinely external Session was handed off as hosted.
 */
describe('session transcript-storage authority', () => {
    it('proves persisted only from a readable owner view that carries no link', () => {
        expect(resolveSessionStorageAuthority(layoutZero({ path: '/repo' })))
            .toEqual({ ok: true, storageKind: 'persisted' });
        expect(resolveSessionStorageAuthority(layoutZero({ path: '/repo', externalSessionV1: VALID_LINK })))
            .toEqual({ ok: true, storageKind: 'direct' });
    });

    it('reads an owner-only layout-1 link as direct, which the shared projection cannot see', () => {
        const session = layoutOne({ path: '/repo', machineId: 'machine-source', externalSessionV1: VALID_LINK });
        // The hazard is real only if the shared record genuinely reads as link-free.
        expect(resolveSessionStorageAuthority({ metadata: session.metadata, metadataLayoutVersion: 0 }))
            .toEqual({ ok: true, storageKind: 'persisted' });
        expect(resolveSessionStorageAuthority(session)).toEqual({ ok: true, storageKind: 'direct' });
    });

    it('refuses instead of answering persisted when this device cannot read the owner view', () => {
        const session = layoutOne(
            { path: '/repo', machineId: 'machine-source', externalSessionV1: VALID_LINK },
            { projected: false },
        );
        expect(resolveSessionStorageAuthority(session))
            .toEqual({ ok: false, errorCode: 'session_owner_metadata_unavailable' });
        expect(resolveSessionStorageAuthority({ metadata: {}, metadataLayoutVersion: 7 }))
            .toEqual({ ok: false, errorCode: 'session_owner_metadata_unavailable' });
        expect(resolveSessionStorageAuthority(null))
            .toEqual({ ok: false, errorCode: 'session_owner_metadata_unavailable' });
    });

    it.each([
        [
            'a malformed canonical link',
            {
                externalSessionV1: {
                    ...VALID_LINK,
                    followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
                },
            },
            'linked_session_invalid',
        ],
        [
            'dual rows requiring reconciliation',
            {
                externalSessionV1: VALID_LINK,
                directSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-legacy',
                    remoteSessionId: 'remote-legacy',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            },
            'linked_session_reconciliation_required',
        ],
    ])('refuses %s instead of stamping a storage mode', (_label, link, errorCode) => {
        expect(resolveSessionStorageAuthority(layoutZero({ path: '/repo', ...link })))
            .toEqual({ ok: false, errorCode });
    });

    /**
     * Presentation keeps its lenient projection: a list row and a header must
     * still render for a Session whose owner view has not landed. Only the
     * authority path refuses.
     */
    it('keeps the lenient presentation projection for unreadable and unresolved links', () => {
        expect(getSessionStorageKind(null)).toBe('persisted');
        expect(getSessionStorageKind(layoutOne(
            { path: '/repo', externalSessionV1: VALID_LINK },
            { projected: false },
        ))).toBe('persisted');
        expect(getSessionStorageKind(layoutZero({
            path: '/repo',
            externalSessionV1: { ...VALID_LINK, followStatusV1: { v: 1, status: 'nope', updatedAtMs: 1 } },
        }))).toBe('persisted');
        expect(getSessionStorageKind(layoutZero({ path: '/repo', externalSessionV1: VALID_LINK }))).toBe('direct');
    });
});

/**
 * Pre-existing presentation coverage, preserved verbatim: the lenient
 * projection must keep reading canonical and supported released link shapes
 * through the same reader.
 */
const canonicalLinkedSession = {
    v: 1,
    agentId: 'claude',
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'project-1',
    },
} as const;

const { agentId: releasedAgentId, ...releasedLinkFields } = canonicalLinkedSession;
const releasedLinkedSession = { ...releasedLinkFields, providerId: releasedAgentId } as const;

describe('getSessionStorageKind', () => {
    it('classifies canonical and supported legacy external-session metadata through the same reader', () => {
        expect(getSessionStorageKind({
            metadata: {
                externalSessionV1: canonicalLinkedSession,
            },
        })).toBe('direct');

        expect(getSessionStorageKind({
            metadata: {
                directSessionV1: releasedLinkedSession,
            },
        })).toBe('direct');
    });

    it('rejects malformed external-session-shaped metadata', () => {
        expect(getSessionStorageKind({
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                },
            },
        })).toBe('persisted');
    });

    /**
     * The same malformed row is NOT a storage answer for a caller that stamps
     * an effect with it.
     */
    it('is not the reader an authority path may use for that malformed row', () => {
        expect(resolveSessionStorageAuthority({
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                },
            },
        })).toEqual({ ok: false, errorCode: 'linked_session_invalid' });
    });
});
