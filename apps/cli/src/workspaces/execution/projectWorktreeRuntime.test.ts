import { describe, expect, it } from 'vitest';
import { projectWorktreeRuntimeEnvironment } from './projectWorktreeRuntime';
import { configuration } from '@/configuration';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { parseLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';

describe('assigned Project runtime defaults', () => {
    const workspace = { id: 'worktree-identity', serverId: 'home', rootPath: '/projects/feature', machineId: 'machine' };
    const assignment = { ports: [42001, 42002], listenerPorts: { capture: 42003 } };
    it('projects the selected declaration slot without giving every service the primary port', () => {
        const manifest = { version: 1 as const, worktreePorts: { enabled: true as const, slots: 2 }, services: {
            web: { source: { kind: 'command' as const, command: 'serve' }, runtime: { primary: true } },
            api: { source: { kind: 'command' as const, command: 'api' }, runtime: { portSlot: 1 } },
            jobs: { source: { kind: 'command' as const, command: 'jobs' } },
        } };
        const input = { workspace, manifest, assignment };
        expect(projectWorktreeRuntimeEnvironment({ ...input, serviceName: 'api' })).toMatchObject({
            PORT: '42002', HAPPIER_WORKTREE_PORT: '42001', HAPPIER_WORKTREE_PORT_1: '42002',
            HAPPIER_WORKTREE_LOCAL_URL: 'http://127.0.0.1:42001',
        });
        expect(projectWorktreeRuntimeEnvironment({ ...input, serviceName: 'web' }).PORT).toBe('42001');
        expect(projectWorktreeRuntimeEnvironment({ ...input, serviceName: 'jobs' })).not.toHaveProperty('PORT');
        expect(projectWorktreeRuntimeEnvironment(input).PORT).toBe('42001');
    });
    it('supplies the stable primary declaration locator independently of port and selected service', () => {
        const manifest = { version: 1 as const, worktreePorts: { enabled: true as const, slots: 2 }, services: {
            api: { source: { kind: 'command' as const, command: 'api' }, runtime: { portSlot: 1 } },
            web: { source: { kind: 'command' as const, command: 'serve' }, runtime: { primary: true } },
        } };
        const input = { workspace, manifest, assignment, serviceName: 'api' };
        const url = projectWorktreeRuntimeEnvironment(input).HAPPIER_WORKTREE_URL;
        expect(url).toBeDefined();
        expect(new URL(url!).origin).toBe(new URL(configuration.webappUrl).origin);
        expect(parseLocalServiceDeclarationPreviewLandingUrlV1(url!)).toEqual({
            serverId: workspace.serverId, machineId: workspace.machineId,
            targetId: createProjectServiceDeclarationTargetIdV1(workspace, { kind: 'manifest', name: 'web' }),
        });
        expect(projectWorktreeRuntimeEnvironment({ ...input, manifest: { ...manifest, services: {
            ...manifest.services, web: { ...manifest.services.web, runtime: { portSlot: 0 } },
        } } }).HAPPIER_WORKTREE_URL).toBe(url);
        expect(projectWorktreeRuntimeEnvironment({ ...input, assignment: { ...assignment, ports: [43001, 43002] } })
            .HAPPIER_WORKTREE_URL).toBe(url);
        expect(projectWorktreeRuntimeEnvironment({ ...input, workspace: { ...workspace, id: 'sibling' } })
            .HAPPIER_WORKTREE_URL).not.toBe(url);
        expect(projectWorktreeRuntimeEnvironment({ ...input, manifest: { ...manifest, services: {
            api: manifest.services.api,
        } } })).not.toHaveProperty('HAPPIER_WORKTREE_URL');
    });
    it('does not enable Project port injection for listener-only demand or explicit opt-out', () => {
        for (const manifest of [null, { version: 1 as const }, { version: 1 as const, worktreePorts: { enabled: false as const } }]) {
            expect(projectWorktreeRuntimeEnvironment({ workspace, manifest, assignment })).toEqual({});
        }
    });
    it('uses a portable identity-derived slug without inventing a primary declaration', () => {
        const manifest = { version: 1 as const, worktreePorts: { enabled: true as const, slots: 2 } };
        const input = { workspace, manifest, assignment };
        const first = projectWorktreeRuntimeEnvironment(input);
        expect(first.HAPPIER_WORKTREE_SLUG).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(projectWorktreeRuntimeEnvironment(input)).toEqual(first);
        expect(projectWorktreeRuntimeEnvironment({ ...input, workspace: { ...workspace, id: 'sibling' } }).HAPPIER_WORKTREE_SLUG)
            .not.toBe(first.HAPPIER_WORKTREE_SLUG);
        expect(first).not.toHaveProperty('HAPPIER_WORKTREE_URL');
    });
});
