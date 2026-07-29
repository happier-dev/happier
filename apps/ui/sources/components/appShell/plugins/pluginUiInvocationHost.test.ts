import { describe, expect, it, vi } from 'vitest';

import { createAppShellPluginUiInvocationHost } from './pluginUiInvocationHost';

describe('AppShell plugin UI invocation host', () => {
    it('qualifies a local action and delegates to the daemon invocation owner with generation, timeout, and caller signal', async () => {
        const signal = new AbortController().signal;
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { token: 'bounded-artifact' } },
        }));
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice',
            contributionId: 'conversation',
            generation: '12',
            machineId: 'machine-1',
            serverId: 'server-1',
            signal,
            timeoutMs: 5_000,
            isCurrent: () => true,
            execute,
        });

        await expect(ui.executeAction('mint-session', { voice: 'alloy' }))
            .resolves.toEqual({ token: 'bounded-artifact' });
        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '12',
            qualifiedActionId: 'acme.voice/mint-session',
            input: { voice: 'alloy' },
            executionSurface: 'ui',
            timeoutMs: 5_000,
            signal,
        });
    });

    it('fails before dispatch when the generation is stale or the caller is aborted', async () => {
        const execute = vi.fn();
        const stale = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => false, execute,
        });
        await expect(stale.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_generation_retired',
        });

        const caller = new AbortController();
        caller.abort();
        const aborted = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true, execute,
        });
        await expect(aborted.executeAction('mint-session', null, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_ui_invocation_aborted',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('preserves a settled daemon success when caller cancellation races result delivery', async () => {
        const caller = new AbortController();
        const cancelledAfterSettlement = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            execute: async () => {
                const settled = { supported: true as const, result: { ok: true as const, result: { token: 'known-success' } } };
                caller.abort(new Error('caller stopped'));
                return settled;
            },
        });
        await expect(cancelledAfterSettlement.executeAction('mint-session', null, { signal: caller.signal }))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('preserves a settled daemon success when generation retirement races result delivery', async () => {
        let current = true;
        const retiredInFlight = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => current,
            execute: async () => {
                const settled = { supported: true as const, result: { ok: true as const, result: { token: 'known-success' } } };
                current = false;
                return settled;
            },
        });
        await expect(retiredInFlight.executeAction('mint-session', null))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('normalizes daemon unavailability and action errors', async () => {
        const unavailable = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            execute: async () => ({ supported: false, reason: 'not-supported' }),
        });
        await expect(unavailable.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_action_host_unavailable',
        });

        const denied = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            execute: async () => ({ supported: true, result: { ok: false, code: 'plugin_action_grant_missing' } }),
        });
        await expect(denied.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_action_grant_missing',
        });
    });
});
