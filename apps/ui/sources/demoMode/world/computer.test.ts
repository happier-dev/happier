import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { useComputerScreen } from '@/components/computer/useComputerScreen';
import { buildDemoComputerWorld } from './computer';

describe('the Computer stage machine boundary', () => {
    it('refuses an Action outside the runtime family without claiming success', async () => {
        const world = buildDemoComputerWorld(async () => new Uint8Array());
        try {
            await expect(world.execute('session.open', { sessionId: world.scope.sessionId },
                { authority: 'present_user', surface: 'ui' })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        } finally { world.dispose(); }
    });
    it('feeds the real control/stream owner and supports takeover, hand back, stop and reopening', async () => {
        const bytes = new Uint8Array(readFileSync('public/static/demo/fieldwork-desktop.png'));
        const world = buildDemoComputerWorld(async () => bytes);
        const hook = await renderHook(() => useComputerScreen({
            scope: world.scope, execute: world.execute, transport: world.transport,
            agent: { agentId: 'claude', name: 'Claude' },
        }));
        try {
            expect(hook.getCurrent()).toMatchObject({ shared: true, targetTitle: 'Fieldwork · Checkout', machineName: 'MacBook Pro', presence: { kind: 'agent' } });
            expect(hook.getCurrent().stream?.playerState?.lastFrameUrl).toMatch(/^data:image\/jpeg;base64,/);
            await act(async () => { await hook.getCurrent().onTakeControl(); });
            expect(hook.getCurrent().presence.kind).toBe('human');
            await act(async () => { hook.getCurrent().onHandBack(); });
            expect(hook.getCurrent().presence.kind).toBe('agent');
            const request = hook.getCurrent().resolveChooseWindow();
            expect(request?.execute).toBe(world.execute);
            await act(async () => { hook.getCurrent().onStopSharing(); });
            expect(hook.getCurrent().shared).toBe(false);
            await act(async () => {
                const selected = await world.execute('computer.target.select', { machineId: world.scope.machineId,
                    target: { kind: 'window', displayId: ':0', pid: 101, windowId: 12 }, access: 'use' },
                { authority: 'present_user', surface: 'ui', defaultSessionId: world.scope.sessionId });
                expect(selected.ok).toBe(true);
            });
            await act(async () => { hook.getCurrent().onRefresh?.(); });
            expect(hook.getCurrent().shared).toBe(true);
        } finally { await hook.unmount(); world.dispose(); }
    });
});
