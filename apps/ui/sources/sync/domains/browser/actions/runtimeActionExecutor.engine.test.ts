import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { applyBrowserControlEvent, createBrowserControlState } from '../control';
import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { BrowserTargetPolicyDecisionV1Schema } from '@happier-dev/protocol/browser/policy/v1';
import { createBrowserRuntimeActionExecutor } from './runtimeActionExecutor';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';

describe('portable Browser engine choice', () => {
    it.each(['agent', 'mcp', 'plugin', 'ui'] as const)('honors the %s typed engine choice through Action admission', async surface => {
        let state = createBrowserControlState();
        const machine = vi.fn(async (_args: RuntimeActionExecuteArgs) => ({ v: 1, commandId: 'switch-managed', status: 'dispatched',
            adapterKind: 'chromiumSidecar', events: [] }));
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: createBrowserRuntimeActionExecutor({
                control: {
                    readState: () => state,
                    applyDispatchResult: result => { state = result.state; },
                    readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({
                        targetKind: 'externalUrl', state: 'allowed',
                    }) }),
                },
                executeOnMachine: machine,
            }),
        }));
        const command = { kind: 'openView', commandId: 'switch-managed', browserSessionId: 'local-browser',
            viewId: 'page', platform: 'ios', target: { kind: 'externalUrl', targetId: 'site', url: 'https://example.com/' } } as const;
        const context = { surface, authority: 'account_automation', bypassApprovals: true,
            defaultSessionId: 'machine-session', externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
        expect(await execute.execute('browser.view.open', { ...command, engineOverride: 'managed' }, context))
            .toMatchObject({ ok: true, result: { status: 'dispatched', adapterKind: 'chromiumSidecar' } });
        expect(machine.mock.calls[0]?.[0]).toMatchObject({ input: { engineOverride: 'managed', browserSessionId: 'machine-session' } });
        machine.mockClear();
        expect(await execute.execute('browser.view.open', { ...command, commandId: 'switch-embedded', engineOverride: 'embedded' }, context))
            .toMatchObject({ ok: true, result: { status: 'dispatched', adapterKind: 'externalUrl' } });
        expect(state.viewsById.page).toMatchObject({ engineKind: 'nativeWebView' });
        expect(machine).not.toHaveBeenCalled();
    });

    it('keeps an explicit managed refusal visible instead of opening embedded', async () => {
        let state = createBrowserControlState();
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: createBrowserRuntimeActionExecutor({
                control: {
                    readState: () => state,
                    applyDispatchResult: result => { state = result.state; },
                    readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({
                        targetKind: 'externalUrl', state: 'allowed',
                    }) }),
                },
                executeOnMachine: async () => ({ v: 1, commandId: 'managed-refused', status: 'failed',
                    error: { code: 'adapter_unavailable', message: 'Managed browser unavailable' } }),
            }),
        }));
        expect(await execute.execute('browser.view.open', {
            kind: 'openView', commandId: 'managed-refused', browserSessionId: 'local-browser', viewId: 'page',
            platform: 'ios', engineOverride: 'managed',
            target: { kind: 'externalUrl', targetId: 'site', url: 'https://example.com/' },
        }, { surface: 'agent', authority: 'account_automation', bypassApprovals: true,
            defaultSessionId: 'machine-session', externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'adapter_unavailable' });
        expect(state.viewsById).toEqual({});
    });

    it.each(['openView', 'setTarget'] as const)('switches an existing managed view to embedded through %s in the registered viewer', async kind => {
        let state = applyBrowserControlEvent(createBrowserControlState(), {
            kind: 'viewOpened', eventId: 'managed-view', browserSessionId: 'local-browser', viewId: 'page',
            platform: 'ios', target: { kind: 'externalUrl', targetId: 'site', url: 'https://example.com/' },
            currentUrl: 'https://example.com/', adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
                supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'] }), occurredAt: 1,
        });
        const machine = vi.fn(async (_args: RuntimeActionExecuteArgs) => ({ ok: false, errorCode: 'browser_control_unavailable' }));
        const execute = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: createBrowserRuntimeActionExecutor({
                resolveControl: () => ({
                    readState: () => state,
                    applyDispatchResult: result => { state = result.state; },
                    readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({
                        targetKind: 'externalUrl', state: 'allowed',
                    }) }),
                }),
                executeOnMachine: machine,
            }),
        }));
        expect(await execute.execute(kind === 'openView' ? 'browser.view.open' : 'browser.target.set', {
            kind, commandId: 'registered-embedded', browserSessionId: 'local-browser', viewId: 'page',
            ...(kind === 'openView' ? { platform: 'ios' } : {}), engineOverride: 'embedded',
            target: { kind: 'externalUrl', targetId: 'site', url: 'https://example.com/' },
        }, { surface: 'agent', authority: 'account_automation', bypassApprovals: true,
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: true, result: { status: 'dispatched', adapterKind: 'externalUrl' } });
        expect(state.viewsById.page).toMatchObject({ engineKind: 'nativeWebView' });
        expect(machine).not.toHaveBeenCalled();
    });
});
