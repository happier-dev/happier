import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { ComputerActionResultReference } = await import('./ComputerActionResultReference');
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

describe('Computer move transcript reference', () => {
    it.each([
        { state: 'running' as const, label: 'Moving the pointer' },
        { state: 'completed' as const, label: 'Moved the pointer' },
    ])('describes $state pointer movement without calling it a click', async ({ state, label }) => {
        fixture = await createPlainArtifactHomeFixture('https://computer-move-reference.example.test');
        const screen = await renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={captureActiveServerAccountScopeLifetime()}>
            <ComputerActionResultReference sessionId="reference-session" serverId={fixture.home.id} tool={makeToolCall({
                name: 'mcp__happier__action_execute', state,
                input: { actionId: 'computer.input', input: { machineId: 'machine-reference', captureId: 'capture-reference',
                    operation: { kind: 'move', x: 1, y: 2 } } },
                result: state === 'completed' ? { status: 'dispatched', target: { kind: 'display', displayId: ':77' }, sourceId: 'source-reference' } : undefined,
            })} />
        </SessionViewerSourceAccountScopeProvider>);
        expect(screen.getTextContent()).toContain(label);
    });
});
