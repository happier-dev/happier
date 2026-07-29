import { describe, expect, it } from 'vitest';

import { resolveResourceScope } from './resolveResourceScope';

describe('resolveResourceScope', () => {
    it('fails closed to app scope with empty resource scope for a missing target', () => {
        const resolution = resolveResourceScope(undefined);
        expect(resolution.targetKind).toBe('app');
        expect(resolution.resourceScope).toEqual([]);
    });

    it('fails closed to app scope for an unknown target kind', () => {
        const resolution = resolveResourceScope({ kind: 'mystery' });
        expect(resolution.targetKind).toBe('app');
        expect(resolution.resourceScope).toEqual([]);
    });

    it('resolves a session target to a session resource scope (no path)', () => {
        const resolution = resolveResourceScope({ kind: 'session' });
        expect(resolution.targetKind).toBe('session');
        expect(resolution.resourceScope).toEqual([{ kind: 'session' }]);
    });

    it('forwards the declared sessionIdPath onto the session resource target', () => {
        const resolution = resolveResourceScope({ kind: 'session', sessionIdPath: '/context/sessionId' });
        expect(resolution.targetKind).toBe('session');
        expect(resolution.resourceScope).toEqual([{ kind: 'session', idPath: '/context/sessionId' }]);
    });

    it('resolves a workspace target with its workspace ref path', () => {
        const resolution = resolveResourceScope({ kind: 'workspace', workspaceRefIdPath: '/ws/id' });
        expect(resolution.targetKind).toBe('workspace');
        expect(resolution.resourceScope).toEqual([{ kind: 'workspace', idPath: '/ws/id' }]);
    });

    it('resolves a project target to its workspace ref scope', () => {
        const resolution = resolveResourceScope({ kind: 'project', workspaceRefIdPath: '/ws/id' });
        expect(resolution.targetKind).toBe('project');
        expect(resolution.resourceScope).toEqual([{ kind: 'workspace', idPath: '/ws/id' }]);
    });

    it('resolves a services target to a session resource scope', () => {
        const resolution = resolveResourceScope({ kind: 'services', sessionIdPath: '/svc/sessionId' });
        expect(resolution.targetKind).toBe('services');
        expect(resolution.resourceScope).toEqual([{ kind: 'session', idPath: '/svc/sessionId' }]);
    });

    it('resolves browser + app targets to an empty resource scope', () => {
        expect(resolveResourceScope({ kind: 'browser', browserViewIdPath: '/v' }).resourceScope).toEqual([]);
        expect(resolveResourceScope({ kind: 'browser', browserViewIdPath: '/v' }).targetKind).toBe('browser');
        expect(resolveResourceScope({ kind: 'app' }).resourceScope).toEqual([]);
        expect(resolveResourceScope({ kind: 'app' }).targetKind).toBe('app');
    });
});
