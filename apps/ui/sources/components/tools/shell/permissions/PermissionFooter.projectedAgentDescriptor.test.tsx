import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EXTERNAL_AGENT_ID = 'acme.agent';

const ops = vi.hoisted(() => ({
    sessionDeny: vi.fn(async (..._args: unknown[]) => {}),
    sessionAbort: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installPermissionShellCommonModuleMocks({});

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: ops.sessionDeny,
    sessionAbort: ops.sessionAbort,
}));

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => EXTERNAL_AGENT_ID,
}));

// The footer copy owner is deliberately NOT stubbed here: an external Agent must
// reach the same neutral copy a bundled Agent gets, and stubbing it would hide a
// footer that never renders.
async function renderPendingPermissionFooter() {
    const { PermissionFooter } = await import('./PermissionFooter');
    return await renderScreen(React.createElement(PermissionFooter, {
        permission: { id: 'p1', status: 'pending' },
        sessionId: 's1',
        toolName: 'execute',
        toolInput: { command: 'pwd' },
        metadata: { flavor: EXTERNAL_AGENT_ID },
    }));
}

describe('PermissionFooter for an external Agent', () => {
    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        clearProjectedAgentUiBehaviorDescriptors();
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
    });

    it('renders the approve, deny and stop actions for a pending request', async () => {
        const screen = await renderPendingPermissionFooter();

        for (const testID of ['permission-footer.allow', 'permission-footer.deny', 'permission-footer.stop']) {
            expect(screen.findAllByTestId(testID).length).toBeGreaterThan(0);
        }
    });

    it('honors the projected descriptor stop handling instead of aborting the run', async () => {
        const { publishProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'm1',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { permissions: { footer: { stopHandling: 'denyOnly' } } },
            },
        });

        const screen = await renderPendingPermissionFooter();
        await screen.pressByTestIdAsync('permission-footer.stop');

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionAbort).not.toHaveBeenCalled();
    });

    it('still aborts the run for an external Agent that ships no descriptor', async () => {
        const screen = await renderPendingPermissionFooter();
        await screen.pressByTestIdAsync('permission-footer.stop');

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionAbort).toHaveBeenCalledTimes(1);
    });
});
