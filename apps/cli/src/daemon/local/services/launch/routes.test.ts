import { describe, expect, it, vi } from 'vitest';

import { createLocalServiceLauncherRoutes } from './routes';
import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';

type StartDeclarationFixture = Readonly<{
    targetId: string;
    serviceKey: string;
}>;

function launcherSnapshot(
    overrides: Partial<LocalServiceLauncherSnapshotV1> = {},
): LocalServiceLauncherSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [],
        ...overrides,
    };
}

describe('createLocalServiceLauncherRoutes', () => {
    it('serves the daemon launcher feed snapshot without rebuilding it at the route boundary', async () => {
        const snapshot = {
            v: 1 as const,
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            targets: [],
        };
        const feed = {
            getSnapshot: vi.fn(async () => snapshot),
        };

        const routes = createLocalServiceLauncherRoutes({ feed });

        await expect(routes.getSnapshot()).resolves.toEqual(snapshot);
        expect(feed.getSnapshot).toHaveBeenCalledTimes(1);
    });

    it('starts a retained managed declaration and returns the post-start launcher snapshot', async () => {
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        const declaration = { targetId: `managed:${serviceKey}`, serviceKey } satisfies StartDeclarationFixture;
        const preStartSnapshot = launcherSnapshot({
            targets: [{
                id: declaration.targetId,
                source: 'managed_service' as const,
                sourceClass: {
                    kind: 'managed_service' as const,
                    managedServiceId: serviceKey,
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                title: 'Preview web',
                subtitle: 'web',
                kind: 'managed_service',
                confidence: 'medium' as const,
                state: 'available' as const,
                actions: ['start' as const],
            }],
        });
        const postStartSnapshot = launcherSnapshot({
            updatedAt: 4_000,
            targets: [{
                id: 'preview:plugin-managed:acme.preview:preview-web:web',
                source: 'registered_preview' as const,
                sourceClass: {
                    kind: 'registered_preview' as const,
                    previewId: 'plugin-managed:acme.preview:preview-web:web',
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                title: 'Preview web',
                subtitle: 'localhost:5173',
                confidence: 'high' as const,
                state: 'available' as const,
                actions: [],
            }],
        });
        const feed = {
            getSnapshot: vi.fn()
                .mockResolvedValueOnce(preStartSnapshot)
                .mockResolvedValueOnce(postStartSnapshot),
        };
        const resolveStartTarget = vi.fn(() => ({ ok: true as const, declaration }));
        const startManagedDeclaration = vi.fn(async () => ({ status: 'succeeded' as const }));
        const routeInput: Parameters<typeof createLocalServiceLauncherRoutes>[0] & Readonly<{
            resolveStartTarget(request: Readonly<{
                machineId: string;
                targetId: string;
                sessionId?: string;
                workspaceId?: string;
            }>): Readonly<
                | { ok: true; declaration: StartDeclarationFixture }
                | { ok: false; reasonCode: string }
            >;
            startManagedDeclaration(
                declaration: StartDeclarationFixture,
            ): Promise<Readonly<{ status: 'succeeded' } | { status: 'denied' | 'failed'; reasonCode: string }>>;
        }> = {
            feed,
            resolveStartTarget,
            startManagedDeclaration,
        };

        const routes = createLocalServiceLauncherRoutes(routeInput);

        await expect(routes.startTarget?.({
            machineId: 'machine-a',
            targetId: declaration.targetId,
            sessionId: 'session-a',
        })).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: declaration.targetId,
            status: 'succeeded',
            snapshot: postStartSnapshot,
        });
        expect(resolveStartTarget).toHaveBeenCalledWith({
            machineId: 'machine-a',
            targetId: declaration.targetId,
            sessionId: 'session-a',
        });
        expect(startManagedDeclaration).toHaveBeenCalledWith(declaration, {
            machineId: 'machine-a',
            targetId: declaration.targetId,
            sessionId: 'session-a',
        });
        expect(feed.getSnapshot).toHaveBeenCalledTimes(2);
    });

    it('denies unsupported launcher start targets without spawning', async () => {
        const snapshot = launcherSnapshot({
            targets: [{
                id: 'package:web:dev',
                source: 'package_script' as const,
                sourceClass: {
                    kind: 'package_script' as const,
                    runTargetId: 'web:dev',
                    packageName: 'web',
                    scriptName: 'dev',
                    cwd: '/repo/web',
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                cwd: '/repo/web',
                title: 'web:dev',
                subtitle: '/repo/web',
                kind: 'package_script',
                commandPreview: 'npm run dev',
                confidence: 'medium' as const,
                state: 'unavailable' as const,
                unavailableReason: 'launch_unavailable',
                actions: [],
            }],
        });
        const feed = {
            getSnapshot: vi.fn(async () => snapshot),
        };
        const startManagedDeclaration = vi.fn(async () => ({ status: 'succeeded' as const }));
        const routeInput: Parameters<typeof createLocalServiceLauncherRoutes>[0] & Readonly<{
            startManagedDeclaration(): Promise<Readonly<{ status: 'succeeded' }>>;
        }> = {
            feed,
            startManagedDeclaration,
        };

        const routes = createLocalServiceLauncherRoutes(routeInput);

        await expect(routes.startTarget?.({
            machineId: 'machine-a',
            targetId: 'package:web:dev',
            sessionId: 'session-a',
        })).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'package:web:dev',
            status: 'denied',
            reasonCode: 'package_script_start_unavailable',
            snapshot,
        });
        expect(feed.getSnapshot).toHaveBeenCalledTimes(1);
        expect(startManagedDeclaration).not.toHaveBeenCalled();
    });

    it('denies retained declarations when the current snapshot does not advertise Start', async () => {
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        const declaration = { targetId: `managed:${serviceKey}`, serviceKey } satisfies StartDeclarationFixture;
        const snapshot = launcherSnapshot({
            targets: [{
                id: 'preview:plugin-managed:acme.preview:preview-web:web',
                source: 'registered_preview' as const,
                sourceClass: {
                    kind: 'registered_preview' as const,
                    previewId: 'plugin-managed:acme.preview:preview-web:web',
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                title: 'Preview web',
                subtitle: 'localhost:5173',
                confidence: 'high' as const,
                state: 'available' as const,
                actions: [],
            }],
        });
        const feed = {
            getSnapshot: vi.fn(async () => snapshot),
        };
        const resolveStartTarget = vi.fn(() => ({ ok: true as const, declaration }));
        const startManagedDeclaration = vi.fn(async () => ({ status: 'succeeded' as const }));
        const routeInput: Parameters<typeof createLocalServiceLauncherRoutes>[0] & Readonly<{
            resolveStartTarget(): Readonly<{ ok: true; declaration: StartDeclarationFixture }>;
            startManagedDeclaration(): Promise<Readonly<{ status: 'succeeded' }>>;
        }> = {
            feed,
            resolveStartTarget,
            startManagedDeclaration,
        };

        const routes = createLocalServiceLauncherRoutes(routeInput);

        await expect(routes.startTarget?.({
            machineId: 'machine-a',
            targetId: declaration.targetId,
            sessionId: 'session-a',
        })).resolves.toMatchObject({
            status: 'denied',
            reasonCode: 'launcher_start_unsupported',
        });
        expect(startManagedDeclaration).not.toHaveBeenCalled();
    });

    it('denies unknown targets and wrong machines with stable reasons before spawning', async () => {
        const snapshot = launcherSnapshot();
        const feed = {
            getSnapshot: vi.fn(async () => snapshot),
        };
        const startManagedDeclaration = vi.fn(async () => ({ status: 'succeeded' as const }));
        const routeInput: Parameters<typeof createLocalServiceLauncherRoutes>[0] & Readonly<{
            startManagedDeclaration(): Promise<Readonly<{ status: 'succeeded' }>>;
        }> = {
            feed,
            startManagedDeclaration,
        };
        const routes = createLocalServiceLauncherRoutes(routeInput);

        await expect(routes.startTarget?.({
            machineId: 'machine-a',
            targetId: 'managed:missing',
            sessionId: 'session-a',
        })).resolves.toMatchObject({
            status: 'denied',
            reasonCode: 'launcher_target_unknown',
        });
        await expect(routes.startTarget?.({
            machineId: 'machine-b',
            targetId: 'managed:missing',
            sessionId: 'session-a',
        })).resolves.toMatchObject({
            status: 'denied',
            reasonCode: 'wrong_machine',
        });
        expect(startManagedDeclaration).not.toHaveBeenCalled();
    });
});
