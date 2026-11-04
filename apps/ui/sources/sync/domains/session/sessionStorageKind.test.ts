import { describe, expect, it } from 'vitest';

import {
    createSessionOwnerMetadataV1,
    projectSessionOwnerCompatibilityViewV1,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { getSessionStorageKind } from './sessionStorageKind';

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
 * Session's transcript live with an external Agent, or with us? It answers it
 * for presentation only — a list row, filter, or header must keep rendering for
 * a Session whose owner view has not landed or whose link cannot be resolved.
 *
 * No client path stamps this fact on an effect, so the module has exactly one
 * reader. The handoff request carries no source storage mode at all: the source
 * daemon derives transcript storage from the owner metadata it loads itself,
 * before the operation claim and before any stop or export.
 */
describe('session transcript-storage projection', () => {
    it('reads a readable owner view that carries no link as persisted, and a link as direct', () => {
        expect(getSessionStorageKind(layoutZero({ path: '/repo' }))).toBe('persisted');
        expect(getSessionStorageKind(layoutZero({ path: '/repo', externalSessionV1: VALID_LINK }))).toBe('direct');
    });

    it('reads an owner-only layout-1 link as direct, which the shared projection cannot see', () => {
        const session = layoutOne({ path: '/repo', machineId: 'machine-source', externalSessionV1: VALID_LINK });
        // The distinction is real only if the shared record genuinely reads as link-free.
        expect(getSessionStorageKind({ metadata: session.metadata, metadataLayoutVersion: 0 })).toBe('persisted');
        expect(getSessionStorageKind(session)).toBe('direct');
    });

    it('renders persisted when this device cannot read the owner view', () => {
        const session = layoutOne(
            { path: '/repo', machineId: 'machine-source', externalSessionV1: VALID_LINK },
            { projected: false },
        );
        expect(getSessionStorageKind(session)).toBe('persisted');
        expect(getSessionStorageKind({ metadata: {}, metadataLayoutVersion: 7 })).toBe('persisted');
        expect(getSessionStorageKind(null)).toBe('persisted');
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
        ],
    ])('keeps rendering %s instead of failing the row', (_label, link) => {
        expect(getSessionStorageKind(layoutZero({ path: '/repo', ...link }))).toBe('persisted');
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
});
