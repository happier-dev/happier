import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const defaultCapabilityRpc = async (_machineId: any, _request: any, _options: any): Promise<{ ok: true; result: Record<string, unknown> }> => ({
        ok: true as const,
        result: {
            agentId: 'codex',
            modelConfigOptionId: ' engine-choice ',
            configOptions: [
                { id: 'opt1', name: 'Option 1', type: 'boolean', currentValue: true },
            ],
            source: 'dynamic',
        },
    });
const capabilityRpc = vi.fn(defaultCapabilityRpc);

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
beforeEach(async () => {
    capabilityRpc.mockReset();
    capabilityRpc.mockImplementation(defaultCapabilityRpc);
    await preflight.reset();
    probeCache.resetDynamicConfigOptionsProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightConfigOptionsState (cache)', () => {
    it('never exposes the previous draft context as the current authoritative catalog', async () => {
        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');
        const { withNewSessionConfigOptionOverrides } = await import('@/components/sessions/new/modules/newSessionCapabilityProbeContext');
        const { buildDynamicConfigOptionsProbeCacheKey } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCacheKey');
        const { normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts } = await import('@/components/sessions/new/modules/newSessionCapabilityProbeContext');
        const { resolveBackendTargetKeyV2 } = await import('@/agents/backendCatalog/backendTargetKeyV2');
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const previous = withNewSessionConfigOptionOverrides(null, { provider: 'native' });
        const next = withNewSessionConfigOptionOverrides(null, { provider: 'gateway' });
        const cacheKey = buildDynamicConfigOptionsProbeCacheKey({ machineId: 'machine-1',
            targetKey: resolveBackendTargetKeyV2(backendTarget), serverId: preflight.serverId, cwd: '/repo',
            extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(previous) });
        probeCache.writeDynamicConfigOptionsProbeCacheSuccess(cacheKey!, [
            { id: 'provider', name: 'Provider', type: 'select', currentValue: 'native',
                options: [{ value: 'native', name: 'Native' }, { value: 'gateway', name: 'Gateway' }] },
        ]);
        capabilityRpc.mockImplementation(() => new Promise(() => undefined));
        const nextContextCatalogs: Array<readonly unknown[] | null> = [];
        let previousCatalog: ReturnType<typeof useNewSessionPreflightConfigOptionsState>['configOptions'] = null;
        function Harness({ nextContext }: { nextContext: boolean }) {
            const result = useNewSessionPreflightConfigOptionsState({ backendTarget, selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId, cwd: '/repo', probeContext: nextContext ? next : previous });
            if (nextContext) nextContextCatalogs.push(result.configOptions);
            else previousCatalog = result.configOptions;
            return null;
        }
        const screen = await renderScreen(<Harness nextContext={false} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(previousCatalog).toEqual([expect.objectContaining({ currentValue: 'native' })]);
        });
        await screen.update(<Harness nextContext />);
        expect(nextContextCatalogs.length).toBeGreaterThan(0);
        expect(nextContextCatalogs.every((catalog) => catalog === null)).toBe(true);
    });

    it('retains the observed catalog and exposes a failed draft setter with native guidance', async () => {
        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');
        const { withNewSessionConfigOptionOverrides } = await import('@/components/sessions/new/modules/newSessionCapabilityProbeContext');
        const failureMessage = 'Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.';
        capabilityRpc.mockResolvedValue({ ok: true, result: {
            agentId: 'codex', source: 'dynamic', modelConfigOptionId: 'model', configOptions: [
                { id: 'provider', name: 'Provider', type: 'select', currentValue: 'codex', options: [{ value: 'codex', name: 'Codex' }, { value: 'gateway', name: 'Gateway' }] },
            ], refreshError: true, refreshErrorMessage: failureMessage,
        } });
        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | undefined;
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'machine-1', capabilityServerId: preflight.serverId,
                cwd: '/repo',
                probeContext: withNewSessionConfigOptionOverrides(null, { provider: 'gateway' }),
            });
            return null;
        }
        await renderScreen(React.createElement(Harness));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalled();
            expect(latest).toMatchObject({ configOptions: [expect.objectContaining({ currentValue: 'codex' })] });
            expect(latest?.probe).toMatchObject({ failed: true, refreshErrorMessage: failureMessage,
                rejectedConfigOptionOverrides: { provider: 'gateway' } });
        });
    });
    it('does not re-probe when a fresh config options result is cached', async () => {

        capabilityRpc.mockClear();

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | undefined;
        const readLatest = () => {
            if (!latest) throw new Error('Expected preflight config options to render');
            return latest;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root1!: renderer.ReactTestRenderer;
        root1 = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().configOptions).not.toBeNull();
        });
        expect(readLatest().configOptions?.map(option => option.id)).toEqual(['opt1']);
        expect(readLatest().modelConfigOptionId).toBe(' engine-choice ');
        await act(async () => {
            root1.unmount();
        });

        let root2!: renderer.ReactTestRenderer;
        root2 = (await renderScreen(React.createElement(Harness))).tree;
        expect(readLatest().configOptions?.map(option => option.id)).toEqual(['opt1']);
        expect(readLatest().modelConfigOptionId).toBe(' engine-choice ');
        await act(async () => {
            root2.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });

    it('does not attempt config-options probing for plugin backend targets', async () => {

        capabilityRpc.mockClear();

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(0);
    });

    it('keeps config-options probing idle while the selected Agent Settings record loads', async () => {

        capabilityRpc.mockClear();
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();
        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            const result = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                runtimeCarrierAgentId: 'acme.review/provider',
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
                enabled: false,
            } as any);
            expect(result.configOptions).toBeNull();
            expect(result.probe.phase).toBe('idle');
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });
        expect(capabilityRpc).toHaveBeenCalledTimes(0);
    });
});
