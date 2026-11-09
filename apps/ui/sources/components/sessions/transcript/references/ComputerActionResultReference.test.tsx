import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { ComputerActionResultReference } = await import('./ComputerActionResultReference');
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

describe('ComputerActionResultReference Machine identity', () => {
    it.each([
        { operation: { kind: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }, state: 'running' as const, label: 'Dragging' },
        { operation: { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 20 }, state: 'running' as const, label: 'Scrolling' },
        { operation: { kind: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }, state: 'completed' as const, label: 'Dragged' },
        { operation: { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 20 }, state: 'completed' as const, label: 'Scrolled' },
    ])('narrates $state pointer input: $operation.kind', async ({ operation, state, label }) => {
        fixture = await createPlainArtifactHomeFixture('https://computer-reference.example.test');
        const screen = await renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={captureActiveServerAccountScopeLifetime()}>
            <ComputerActionResultReference sessionId="reference-session" serverId={fixture.home.id} tool={makeToolCall({ name: 'mcp__happier__action_execute', state,
                input: { actionId: 'computer.input', input: { machineId: 'machine-reference', captureId: 'capture-reference', operation } },
                result: state === 'completed' ? { status: 'dispatched', target: { kind: 'display', displayId: ':77' }, sourceId: 'source-reference' } : undefined,
            })} />
        </SessionViewerSourceAccountScopeProvider>);
        expect(screen.getTextContent()).toContain(label);
    });

    it('publishes the readable Machine name for action references instead of an id or an unnamed hint', async () => {
        fixture = await createPlainArtifactHomeFixture('https://computer-reference.example.test');
        const serverId = fixture.home.id;
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        const base = createMachineFixture();
        const machine = createMachineFixture({ id: 'machine-reference', metadata: { ...base.metadata!, displayName: 'Studio laptop', host: 'studio' } });
        storage.setState({ machineListByServerId: { [serverId]: [machine] } });
        let name: string | null | undefined;
        function Probe() {
            name = useSessionComputerMachine('reference-session', lifetime, serverId)?.machineName;
            return null;
        }
        const screen = await renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={lifetime}>
            <ComputerActionResultReference sessionId="reference-session" serverId={serverId} tool={makeToolCall({
                name: 'mcp__happier__action_execute', state: 'running',
                input: { actionId: 'computer.capture', input: { machineId: 'machine-reference' } },
            })} />
            <Probe />
        </SessionViewerSourceAccountScopeProvider>);
        expect(name).toBe('Studio laptop');
        expect(screen.getTextContent()).not.toContain('machine-reference');
    });
});
