import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The DOM renderer is not ready in this structural render-count check. The
// composed header test separately drives readiness and real terminal admission.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef(() => React.createElement('xterm-boundary')),
}));

const { showMachineTerminalSheet } = await import('./MachineTerminalSheet');
const { Modal } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storageStore');

afterEach(() => standardCleanup());

// A settled Shell consumes the requester's admitted root, so resource samples
// and unrelated custodian metadata never redraw its card.
it('keeps the terminal card quiet for its Machine\'s resource samples', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const base = createMachineFixture({ id: 'terminal-machine', active: true, activeAt: Date.now() });
    let machine: Machine = { ...base, metadata: { ...base.metadata!, homeDir: '/custodian/private' },
        daemonState: { status: 'running', pid: 1, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'], daemonStateVersion: 1 };
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    showMachineTerminalSheet({ serverId, machineId: machine.id, machineName: 'Box', machineShell: { ok: true, cwd: '/members/bob' } });
    const config = vi.mocked(Modal.show).mock.calls.at(-1)![0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
    let renders = 0;
    const Card = config.component;
    const screen = await renderScreen(<React.Profiler id="card" onRender={() => { renders += 1; }}><Card {...config.props} /></React.Profiler>);
    try {
        await flushHookEffects();
        expect(screen.findByTestId('machine-terminal-waiting')).toBeNull();
        renders = 0;
        for (let sample = 1; sample <= 3; sample++) {
            machine = { ...machine, daemonStateVersion: (machine.daemonStateVersion ?? 0) + 1,
                daemonState: { ...(machine.daemonState ?? {}), resources: { v: 1, sampledAt: sample } } as Machine['daemonState'] };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
        }
        expect(renders).toBe(0);
    } finally { await screen.unmount(); }
});
