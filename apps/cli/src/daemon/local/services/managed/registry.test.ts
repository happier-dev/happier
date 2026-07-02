import { describe, expect, it } from 'vitest';

import { createManagedLocalServiceRegistry } from './registry';

describe('createManagedLocalServiceRegistry', () => {
    it('transitions detect-after-launch services only after inventory correlation is confident enough', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:web',
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

    it('removes intentionally stopped services before process-close handling', () => {
        const registry = createManagedLocalServiceRegistry();
        registry.startDetectAfterLaunch({
            id: 'plugin-a:web',
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
