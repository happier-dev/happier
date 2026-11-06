import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { withNewSessionConfigOptionOverrides, type NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';

const { capabilityRpc } = vi.hoisted(() => ({ capabilityRpc: vi.fn() }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
beforeEach(async () => {
    await preflight.reset();
    cache.resetDynamicModelProbeCacheForTests();
    capabilityRpc.mockReset();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

const backendTarget = { kind: 'backend', backendId: 'codex' } as const;
const luna = { availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }], supportsFreeform: true };

function catalogKey(params: Readonly<{ machineId?: string; cwd?: string; suffix?: readonly string[] }> = {}) {
    return buildDynamicModelProbeCacheKey({
        machineId: params.machineId ?? 'machine-a', targetKey: resolveBackendTargetKeyV2(backendTarget),
        providerConnectionId: null, serverId: preflight.serverId, cwd: params.cwd ?? '/repo',
        extraKeySuffixParts: params.suffix ?? null,
    })!;
}

function renderCatalog(initial: NewSessionCapabilityProbeContext | null, machineId = 'machine-a') {
    const names: Array<string | undefined> = [];
    return { names, hookPromise: renderHook(({ probeContext }: { probeContext: NewSessionCapabilityProbeContext | null }) => {
        const state = useNewSessionPreflightModelsState({ backendTarget, selectedMachineId: machineId,
            capabilityServerId: preflight.serverId, cwd: '/repo', probeContext });
        names.push(state.modelOptions.find((option) => option.value === 'gpt-6-luna')?.label);
        return state;
    }, { initialProps: { probeContext: initial } }) };
}

describe('model catalog identity', () => {
    it('keeps the known catalog through a config-only key change, on every render', async () => {
        cache.writeDynamicModelProbeCacheSuccess(catalogKey(), luna);
        capabilityRpc.mockImplementation(() => createDeferred().promise);
        const { names, hookPromise } = renderCatalog(null);
        const hook = await hookPromise;
        names.length = 0;
        // Reasoning effort settled after load: the probe re-keys and has no answer yet under the new key.
        await hook.rerender({ probeContext: withNewSessionConfigOptionOverrides(null, { reasoning_effort: 'low' }) });
        expect(names.length).toBeGreaterThan(0);
        expect(new Set(names)).toEqual(new Set(['GPT-6-Luna']));
        expect(hook.getCurrent().probe.namesPending).toBe(false);
    });

    it('takes the re-read catalog once the new key answers', async () => {
        cache.writeDynamicModelProbeCacheSuccess(catalogKey(), luna);
        const pending = createDeferred<{ ok: true; result: unknown }>();
        capabilityRpc.mockImplementation(() => pending.promise);
        const { hookPromise } = renderCatalog(null);
        const hook = await hookPromise;
        await hook.rerender({ probeContext: withNewSessionConfigOptionOverrides(null, { reasoning_effort: 'low' }) });
        const reread = { availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna (low)' }], supportsFreeform: true };
        await act(async () => { pending.resolve({ ok: true, result: reread }); await pending.promise; });
        await vi.waitFor(() => {
            expect(hook.getCurrent().modelOptions.find((option) => option.value === 'gpt-6-luna')?.label).toBe('GPT-6-Luna (low)');
        });
    });

    it('still drops the rows when the machine or directory changes what the list is', async () => {
        cache.writeDynamicModelProbeCacheSuccess(catalogKey(), luna);
        capabilityRpc.mockImplementation(() => createDeferred().promise);
        const hook = await renderHook(({ cwd }: { cwd: string }) => useNewSessionPreflightModelsState({ backendTarget,
            selectedMachineId: 'machine-a', capabilityServerId: preflight.serverId, cwd }), { initialProps: { cwd: '/repo' } });
        expect(hook.getCurrent().preflightModels?.availableModels[0]?.id).toBe('gpt-6-luna');
        await hook.rerender({ cwd: '/other' });
        expect(hook.getCurrent().preflightModels).toBeNull();
    });

    it('names a model from rows this device retained under another directory, config or machine', async () => {
        cache.writeDynamicModelProbeCacheSuccess(catalogKey({ machineId: 'machine-b', cwd: '/elsewhere', suffix: ['config-options:{"reasoning_effort":"low"}'] }), luna);
        capabilityRpc.mockImplementation(() => createDeferred().promise);
        const { hookPromise } = renderCatalog(null);
        const hook = await hookPromise;
        expect(hook.getCurrent().preflightModels).toBeNull();
        expect(hook.getCurrent().probe.retainedModelName?.('gpt-6-luna')).toBe('GPT-6-Luna');
        expect(hook.getCurrent().probe.retainedModelName?.('never-seen')).toBeNull();
    });

    it('does not name a model from another Agent\'s rows', async () => {
        const claudeKey = buildDynamicModelProbeCacheKey({ machineId: 'machine-a',
            targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
            providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
        cache.writeDynamicModelProbeCacheSuccess(claudeKey, luna);
        capabilityRpc.mockImplementation(() => createDeferred().promise);
        const { hookPromise } = renderCatalog(null);
        expect((await hookPromise).getCurrent().probe.retainedModelName?.('gpt-6-luna')).toBeNull();
    });

    it('says names are pending from the first render until the catalog answers, and a failure settles it', async () => {
        const pending = createDeferred<{ ok: false; error: { code: string; message: string } }>();
        capabilityRpc.mockImplementation(() => pending.promise);
        const seen: boolean[] = [];
        const hook = await renderHook(() => {
            const state = useNewSessionPreflightModelsState({ backendTarget, selectedMachineId: 'machine-a',
                capabilityServerId: preflight.serverId, cwd: '/repo' });
            seen.push(state.probe.namesPending);
            return state;
        });
        expect(seen[0]).toBe(true);
        expect(hook.getCurrent().probe.namesPending).toBe(true);
        await act(async () => { pending.resolve({ ok: false, error: { code: 'unavailable', message: 'down' } }); await pending.promise; });
        await vi.waitFor(() => { expect(hook.getCurrent().probe.namesPending).toBe(false); });
    });
});
