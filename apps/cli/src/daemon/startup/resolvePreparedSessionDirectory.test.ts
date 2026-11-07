import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol';
import { resolvePreparedSessionDirectory } from './resolvePreparedSessionDirectory';

describe('prepared session directory authority', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(['~', '~/projects\\child', '~\\projects/child'])(
        'expands the stored home path before it becomes the runner root (%s)', path => {
            vi.stubEnv('HOME', '/home/happier');
            vi.stubEnv('USERPROFILE', '/home/happier');
            expect(resolvePreparedSessionDirectory({
                options: { directory: '/home/happier' },
                normalizedExistingSessionId: 'copied-child',
                existingSessionWorkspacePath: path,
                ownerMetadata: { v: 1, workspace: { path } },
            }).directory).toBe(path === '~' ? '/home/happier' : join('/home/happier', 'projects', 'child'));
        },
    );

    it('expands a fresh home path before any filesystem or process operation', () => {
        vi.stubEnv('HOME', '/home/happier');
        vi.stubEnv('USERPROFILE', '/home/happier');
        expect(resolvePreparedSessionDirectory({ options: { directory: '~' },
            normalizedExistingSessionId: '', existingSessionWorkspacePath: null, ownerMetadata: null,
        }).directory).toBe('/home/happier');
    });

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
