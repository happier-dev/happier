import { describe, expect, it } from 'vitest';

import { resolveResourceScope } from './resolveResourceScope';

function expectDeclared(resolution: ReturnType<typeof resolveResourceScope>) {
    if (!resolution.declared) {
        throw new Error(`expected a declared resolution, got ${resolution.reason}`);
    }
    return resolution;
}

describe('resolveResourceScope', () => {
    // r0.9 residual: an undeclared or unrecognized target kind is NOT `app`. `app` is a
    // real, reachable public target — reporting it for a descriptor that never declared
    // it makes a broken surface indistinguishable from a genuine app surface, which is
    // exactly the untruth §3.2 r0.9 removed one layer up.
    it('does not declare a target for a missing target', () => {
        expect(resolveResourceScope(undefined)).toEqual({
            declared: false,
            reason: 'surface_target_undeclared',
        });
    });

    it('does not declare a target for a target record that names no kind', () => {
        expect(resolveResourceScope({})).toEqual({
            declared: false,
            reason: 'surface_target_undeclared',
        });
    });

    it('does not declare a target for an unrecognized target kind', () => {
        expect(resolveResourceScope({ kind: 'mystery' })).toEqual({
            declared: false,
            reason: 'surface_target_undeclared',
        });
    });

    it('declares an app target only when the descriptor actually said app', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'app' }));
        expect(resolution.targetKind).toBe('app');
        expect(resolution.resourceScope).toEqual([]);
    });

    it('resolves a session target to a session resource scope (no path)', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'session' }));
        expect(resolution.targetKind).toBe('session');
        expect(resolution.resourceScope).toEqual([{ kind: 'session' }]);
    });

    it('forwards the declared sessionIdPath onto the session resource target', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'session', sessionIdPath: '/context/sessionId' }));
        expect(resolution.targetKind).toBe('session');
        expect(resolution.resourceScope).toEqual([{ kind: 'session', idPath: '/context/sessionId' }]);
    });

    it('does not treat a legacy workspace record as a surface target', () => {
        expect(resolveResourceScope({ kind: 'workspace', workspaceRefIdPath: '/ws/id' })).toEqual({
            declared: false,
            reason: 'surface_target_undeclared',
        });
    });

    it('resolves a project target to its workspace ref scope', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'project', workspaceRefIdPath: '/ws/id' }));
        expect(resolution.targetKind).toBe('project');
        expect(resolution.resourceScope).toEqual([{ kind: 'workspace', idPath: '/ws/id' }]);
    });

    it('resolves a services target to a session resource scope', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'services', sessionIdPath: '/svc/sessionId' }));
        expect(resolution.targetKind).toBe('services');
        expect(resolution.resourceScope).toEqual([{ kind: 'session', idPath: '/svc/sessionId' }]);
    });

    it('resolves a browser target to an empty resource scope', () => {
        const resolution = expectDeclared(resolveResourceScope({ kind: 'browser', browserViewIdPath: '/v' }));
        expect(resolution.targetKind).toBe('browser');
        expect(resolution.resourceScope).toEqual([]);
    });
});
