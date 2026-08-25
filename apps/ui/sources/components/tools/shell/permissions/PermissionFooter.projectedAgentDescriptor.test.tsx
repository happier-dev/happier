import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EXTERNAL_AGENT_ID = 'acme.agent';

const ops = vi.hoisted(() => ({
    sessionAllow: vi.fn(async (..._args: unknown[]) => {}),
    sessionDeny: vi.fn(async (..._args: unknown[]) => {}),
    sessionAbort: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installPermissionShellCommonModuleMocks({});

vi.mock('@/sync/ops', () => ({
    sessionAllow: ops.sessionAllow,
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
async function renderPendingPermissionFooter(
    options: Readonly<{ machineId?: string; toolInput?: Record<string, unknown> }> = {},
) {
    const { PermissionFooter } = await import('./PermissionFooter');
    return await renderScreen(React.createElement(PermissionFooter, {
        permission: { id: 'p1', status: 'pending' },
        sessionId: 's1',
        toolName: 'execute',
        toolInput: options.toolInput ?? { command: 'pwd' },
        metadata: {
            flavor: EXTERNAL_AGENT_ID,
            ...(options.machineId ? { machineId: options.machineId } : {}),
        },
    }));
}

async function publishForMachine(machineId: string, descriptor: Record<string, unknown>) {
    const { publishProjectedAgentUiBehaviorDescriptors } = await import(
        '@/agents/registry/agentUiBehaviorProjection'
    );
    publishProjectedAgentUiBehaviorDescriptors({
        machineId,
        descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: descriptor },
    });
}

describe('PermissionFooter for an external Agent', () => {
    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        clearProjectedAgentUiBehaviorDescriptors();
        ops.sessionAllow.mockClear();
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

/**
 * An installed Agent's descriptor is a fact of ONE machine. Two machines in the
 * same Account can hold different versions of the same Agent, so a permission
 * request has to be answered with the descriptor of the machine that owns the
 * Session — never with whichever machine happens to sort first.
 */
describe('PermissionFooter across two machines holding different descriptors', () => {
    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        clearProjectedAgentUiBehaviorDescriptors();
        ops.sessionAllow.mockClear();
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
    });

    async function publishDisagreeingMachines() {
        // `machine-a` sorts first, so it is exactly what a machine-blind read
        // returns for a Session that actually runs on `machine-b`.
        await publishForMachine('machine-a', {
            permissions: { footer: { stopHandling: 'denyOnly' } },
        });
        await publishForMachine('machine-b', {
            permissions: { footer: { stopHandling: 'denyAndAbortRun' } },
        });
    }

    it('uses the owning machine’s stop handling, not the first machine’s', async () => {
        await publishDisagreeingMachines();

        const screen = await renderPendingPermissionFooter({ machineId: 'machine-b' });
        await screen.pressByTestIdAsync('permission-footer.stop');

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionAbort).toHaveBeenCalledTimes(1);
    });

    it('still honours the other machine’s deny-only handling for a Session that runs there', async () => {
        await publishDisagreeingMachines();

        const screen = await renderPendingPermissionFooter({ machineId: 'machine-a' });
        await screen.pressByTestIdAsync('permission-footer.stop');

        expect(ops.sessionDeny).toHaveBeenCalledTimes(1);
        expect(ops.sessionAbort).not.toHaveBeenCalled();
    });
});

/**
 * The prompt protocol selects the footer's whole action model, so an installed
 * Agent that speaks the decision protocol has to be able to declare it through
 * the same public block a bundled Agent uses.
 */
describe('PermissionFooter for an external Agent that declares the decision protocol', () => {
    afterEach(async () => {
        const { clearProjectedAgentUiBehaviorDescriptors } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        clearProjectedAgentUiBehaviorDescriptors();
        ops.sessionAllow.mockClear();
        ops.sessionDeny.mockClear();
        ops.sessionAbort.mockClear();
    });

    it('renders the decision action set and answers with a decision', async () => {
        await publishForMachine('machine-a', {
            permissions: {
                promptProtocol: 'codexDecision',
                footer: { supportsExecPolicyAmendment: true },
            },
        });

        const screen = await renderPendingPermissionFooter({
            machineId: 'machine-a',
            toolInput: { command: 'pwd', proposed_execpolicy_amendment: ['allow', 'read'] },
        });

        // These two controls exist only in the decision branch.
        expect(screen.findAllHostsByTestId('permission-footer.allow-for-session').length).toBeGreaterThan(0);
        expect(screen.findAllHostsByTestId('permission-footer.allow-execpolicy').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(ops.sessionAllow).toHaveBeenCalledWith('s1', 'p1', undefined, undefined, 'approved');
    });

    it('keeps the neutral Claude action model for an Agent that declares no protocol', async () => {
        await publishForMachine('machine-a', {
            permissions: { footer: { supportsExecPolicyAmendment: true } },
        });

        const screen = await renderPendingPermissionFooter({
            machineId: 'machine-a',
            toolInput: { command: 'pwd', proposed_execpolicy_amendment: ['allow', 'read'] },
        });

        expect(screen.findAllHostsByTestId('permission-footer.allow-for-session')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('permission-footer.allow-execpolicy')).toHaveLength(0);

        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(ops.sessionAllow).toHaveBeenCalledWith('s1', 'p1');
    });

    it('refuses an unreadable protocol instead of impersonating another Agent family', async () => {
        await publishForMachine('machine-a', {
            permissions: { promptProtocol: 'acmeDecision', footer: { supportsExecPolicyAmendment: true } },
        });

        const screen = await renderPendingPermissionFooter({
            machineId: 'machine-a',
            toolInput: { command: 'pwd', proposed_execpolicy_amendment: ['allow', 'read'] },
        });

        expect(screen.findAllHostsByTestId('permission-footer.allow-execpolicy')).toHaveLength(0);

        const { readProjectedAgentUiBehaviorDiagnostics } = await import(
            '@/agents/registry/agentUiBehaviorProjection'
        );
        expect(readProjectedAgentUiBehaviorDiagnostics('machine-a').map((entry) => entry.path))
            .toContain('permissions.promptProtocol');
    });
});
