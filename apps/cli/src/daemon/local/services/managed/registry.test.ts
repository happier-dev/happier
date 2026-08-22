import { describe, expect, it } from 'vitest';

import { createManagedLocalServiceRegistry } from './registry';

describe('createManagedLocalServiceRegistry', () => {
    it('rejects ownerless managed services at the registry boundary', () => {
        const registry = createManagedLocalServiceRegistry();
        const startDetectAfterLaunch = registry.startDetectAfterLaunch as (input: unknown) => unknown;

        expect(() => startDetectAfterLaunch({
            id: 'plugin-a:web',
            minimumConfidence: 'medium',
            process: { pid: 123, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        })).toThrow('managed_local_service_owner_required');
    });

    it('transitions detect-after-launch services only after inventory correlation is confident enough', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 123, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });

        const unrelated = registry.applyInventoryEntry({
            id: 'machine-a:tcp:127.0.0.1:3000',
            port: 3000,
            confidence: 'high',
            processOwnershipConfidence: 'low',
            provenance: { process: { pid: 999, redacted: true, command: 'npm run dev' } },
        });
        const related = registry.applyInventoryEntry({
            id: 'machine-a:tcp:127.0.0.1:5173',
            port: 5173,
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            provenance: { process: { pid: 123, redacted: true, command: 'npm run dev' } },
        });

        expect(unrelated).toBeNull();
        expect(related).toMatchObject({
            phase: 'running',
            inventoryId: 'machine-a:tcp:127.0.0.1:5173',
            port: 5173,
        });
    });

    it('correlates detect-after-launch services through child listener process lineage', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });

        const related = registry.applyInventoryEntry({
            id: 'machine-a:tcp:127.0.0.1:5173',
            port: 5173,
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            provenance: {
                process: {
                    pid: 400,
                    ppid: 300,
                    lineagePids: [400, 300, 1],
                    redacted: true,
                    command: 'npm run dev',
                },
            },
        });

        expect(related).toMatchObject({
            phase: 'running',
            inventoryId: 'machine-a:tcp:127.0.0.1:5173',
            port: 5173,
        });
    });

    it('treats an exact owned process listener as high-confidence custody', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:exact',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'high',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-exact',
        });

        const related = registry.applyInventoryEntry({
            id: 'machine-a:tcp:127.0.0.1:5174',
            port: 5174,
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            provenance: {
                process: {
                    pid: 300,
                    lineagePids: [300, 1],
                    redacted: true,
                    command: 'fixture-server',
                },
            },
        });

        expect(related).toMatchObject({
            phase: 'running',
            port: 5174,
        });
    });

    it('starts assign-and-inject services in running with the assigned host and port', () => {
        const registry = createManagedLocalServiceRegistry();
        const state = registry.startAssignAndInject({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
            host: '127.0.0.1',
            port: 45_123,
        });

        expect(state).toMatchObject({
            phase: 'running',
            launchMode: 'assignAndInject',
            host: '127.0.0.1',
            port: 45_123,
        });
    });

    it('transitions live services between running and unhealthy, pid-guarded', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startAssignAndInject({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
            host: '127.0.0.1',
            port: 45_123,
        });

        expect(registry.markHealthPhase({ serviceId: 'plugin-a:web', pid: 300, phase: 'unhealthy' })).toMatchObject({ phase: 'unhealthy' });
        expect(registry.markHealthPhase({ serviceId: 'plugin-a:web', pid: 300, phase: 'running' })).toMatchObject({ phase: 'running' });
        // A stale pid cannot flip the phase.
        expect(registry.markHealthPhase({ serviceId: 'plugin-a:web', pid: 999, phase: 'unhealthy' })).toBeNull();
        expect(registry.getService('plugin-a:web')).toMatchObject({ phase: 'running' });
    });

    it('fences a live service when its previously verified process ownership can no longer be proven', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startAssignAndInject({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
            host: '127.0.0.1',
            port: 45_123,
        });

        expect(registry.markProcessOwnershipUnverified({
            serviceId: 'plugin-a:web',
            pid: 300,
        })).toMatchObject({
            phase: 'failed',
            diagnostics: [{ code: 'process_ownership_unverified', severity: 'error' }],
        });
        expect(registry.markProcessOwnershipUnverified({
            serviceId: 'plugin-a:web',
            pid: 999,
        })).toBeNull();
    });

    it('removes intentionally stopped services before process-close handling', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 123, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });

        expect(registry.stopIntentional('plugin-a:web')).toEqual({ ok: true });
        expect(registry.handleProcessExit({ serviceId: 'plugin-a:web', pid: 123, exitCode: 143 })).toEqual({
            ignored: true,
            reason: 'service_not_live',
        });
    });
});
