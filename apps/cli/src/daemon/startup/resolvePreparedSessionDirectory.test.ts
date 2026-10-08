import { describe, expect, it } from 'vitest';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol';
import { resolvePreparedSessionDirectory } from './resolvePreparedSessionDirectory';

describe('prepared session directory authority', () => {
    it('routes managed resume from the persisted owner marker, not caller classification', () => {
        expect(resolvePreparedSessionDirectory({
            options: { directory: '/untrusted', directoryKind: 'path' },
            normalizedExistingSessionId: 'session-1', existingSessionWorkspacePath: '/private/chat',
            ownerMetadata: { v: 1, workspace: { path: '/private/chat', sessionDirectoryV1: { v: 1, kind: 'managed' } } },
        })).toMatchObject({ directory: '/private/chat', directoryKind: 'managed' });
    });

    it('does not promote a legacy path session from caller-provided managed routing or creation tag', () => {
        expect(resolvePreparedSessionDirectory({
            options: { directory: '/untrusted', directoryKind: 'managed', sessionCreationTag: SessionCreationTagV1Schema.parse(`create:v1:${'a'.repeat(43)}`) },
            normalizedExistingSessionId: 'session-1', existingSessionWorkspacePath: '/project',
            ownerMetadata: { v: 1, workspace: { path: '/project' } },
        })).toEqual({ directory: '/project', directoryKind: 'path' });
    });

    it.each([
        { sourceKind: 'path', targetKind: 'managed', expectedKind: 'managed' },
        { sourceKind: 'managed', targetKind: 'path', expectedKind: 'path' },
        { sourceKind: 'managed', targetKind: undefined, expectedKind: 'path' },
    ] as const)('uses replacement runtime directory authority ($sourceKind → $expectedKind)', ({ sourceKind, targetKind, expectedKind }) => {
        expect(resolvePreparedSessionDirectory({
            options: { directory: '/project/my-app', directoryKind: targetKind, attachMetadataIdentityPolicy: 'replace_with_runtime_identity' },
            normalizedExistingSessionId: 'session-1', existingSessionWorkspacePath: '/project',
            ownerMetadata: { v: 1, workspace: { path: '/project', ...(sourceKind === 'managed' ? { sessionDirectoryV1: { v: 1, kind: 'managed' } } : {}) } },
        })).toEqual({ directory: '/project/my-app', directoryKind: expectedKind });
    });

    it('keeps trusted fresh managed routing for a committed child row before its marker is published', () => {
        const sessionCreationTag = SessionCreationTagV1Schema.parse(`create:v1:${'a'.repeat(43)}`);
        expect(resolvePreparedSessionDirectory({
            options: { directory: '/private/chat', directoryKind: 'managed', freshSessionCreation: true, sessionCreationTag },
            normalizedExistingSessionId: 'session-new', existingSessionWorkspacePath: '/private/chat',
            ownerMetadata: { v: 1, workspace: { path: '/private/chat' } },
        })).toMatchObject({ directory: '/private/chat', directoryKind: 'managed', sessionCreationTag });
    });
});
