import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { AgentConfigOptionsProbeObservationSchema, AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { SessionRuntimeFailureCauseV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { flushHookEffects, renderHook } from '@/dev/testkit';

const preflight = await installNewSessionPreflightHarness(async () => { throw new Error('Missing test response'); });
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { discoverMachineModels } = await import('./modelDiscovery');
const cache = await import('@/sync/domains/models/dynamicModelProbeCache');
const configCache = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
const modeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
const { useNewSessionPreflightConfigOptionsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState');
const { useNewSessionPreflightSessionModesState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState');
const { useNewSessionPreflightModelsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState');
const failureCause = SessionRuntimeFailureCauseV1Schema.parse({
    phase: 'client_start', failureReason: 'model_selection_required', retryable: false,
});
const availableModels = [{ id: 'retained', name: 'Retained' }];

beforeEach(async () => {
    await preflight.reset();
    cache.resetDynamicModelProbeCacheForTests();
    configCache.resetDynamicConfigOptionsProbeCacheForTests();
    modeCache.resetDynamicSessionModeProbeCacheForTests();
});
afterAll(() => preflight.dispose());

describe('New Session inventory failure diagnostics', () => {
    it.each([
        ['config', 'unavailable', false, false], ['config', 'refresh', true, false],
        ['config', 'wrapped', false, false], ['config', 'flat', true, false],
        ['modes', 'wrapped', false, false], ['modes', 'flat', true, false],
        ['models', 'unavailable', false, false], ['models', 'refresh', true, false],
        ['models', 'wrapped', false, false], ['models', 'flat', true, false],
        ['config', 'flat', true, true], ['modes', 'flat', true, true],
    ] as const)('retains %s %s cause across cached remounts, retained: %s, unavailable: %s', async (kind, shape, retainGood, initialUnavailable) => {
        let failed = !retainGood;
        const configOptions = [{ id: 'sandbox', name: 'Sandbox', type: 'boolean', currentValue: 'true' }];
        const availableModes = [{ id: 'review', name: 'Review' }];
        preflight.setCapabilityResponder(async () => {
            if (failed && shape === 'wrapped') return { ok: false, error: {
                code: 'connected-service-preflight-failed', message: 'Preparation refused', failureCause,
            } };
            if (failed && shape === 'flat') return { ok: false, error: 'Preparation refused',
                errorCode: 'connected-service-preflight-failed', failureCause };
            return { ok: true, result: kind === 'config' ? AgentConfigOptionsProbeObservationSchema.parse({
                source: initialUnavailable || (failed && shape === 'unavailable') ? 'unavailable' : 'dynamic',
                configOptions: initialUnavailable || (failed && shape === 'unavailable') ? [] : configOptions,
                ...(failed ? { failureCause, refreshError: true } : {}),
            }) : kind === 'models' ? AgentModelsProbeObservationSchema.parse({
                source: failed && shape === 'unavailable' ? 'unavailable' : 'dynamic',
                availableModels: failed && shape === 'unavailable' ? [] : availableModels,
                supportsFreeform: false, observedAt: Date.now(),
                ...(failed ? { failureCause, refreshError: true } : {}),
            }) : AgentSessionModesProbeObservationSchema.parse({ source: initialUnavailable ? 'unavailable' : 'dynamic',
                availableModes: initialUnavailable ? [] : availableModes }) };
        });
        const params = { backendTarget: { kind: 'backend' as const, backendId: 'external.agent/reader' },
            runtimeCarrierAgentId: 'external.agent/reader', selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId, cwd: '/repo' };
        const useInventory = () => kind === 'config'
            ? useNewSessionPreflightConfigOptionsState(params) : kind === 'models'
                ? useNewSessionPreflightModelsState(params) : useNewSessionPreflightSessionModesState(params);
        const persistKey = kind === 'config' ? 'dynamic-config-options-probe-cache-v1'
            : kind === 'models' ? 'dynamic-model-probe-cache-v1' : 'dynamic-session-mode-probe-cache-v1';
        let persistedBefore = window.localStorage.getItem(persistKey);
        const mounted = await renderHook(useInventory);
        try {
            if (retainGood) {
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(mounted.getCurrent().probe).toMatchObject({ phase: 'idle', refreshedAt: expect.any(Number) });
                });
                persistedBefore = window.localStorage.getItem(persistKey);
                failed = true;
                await act(async () => { mounted.getCurrent().probe.onRefresh?.(); });
            }
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(mounted.getCurrent().probe).toMatchObject({ phase: 'idle', failureCause });
            });
            if (retainGood && !initialUnavailable) expect(mounted.getCurrent()).toMatchObject(kind === 'config' ? { configOptions }
                : kind === 'models' ? { preflightModels: { availableModels } } : { preflightModes: { availableModes } });
            expect(window.localStorage.getItem(persistKey)).toBe(persistedBefore);
        } finally { await mounted.unmount(); }
        const remounted = await renderHook(useInventory);
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(remounted.getCurrent().probe).toMatchObject({ phase: 'idle', failureCause });
            });
            if (initialUnavailable) expect(remounted.getCurrent()).toMatchObject(kind === 'config'
                ? { configOptions: [], unavailable: true } : { preflightModes: { availableModes: [], unavailable: true } });
            expect(window.localStorage.getItem(persistKey)).toBe(persistedBefore);
        } finally { await remounted.unmount(); }
    });
});

describe('model discovery diagnostic retention through inventory Actions', () => {
    it.each([
        ['unavailable', false], ['unavailable', true],
        ['refresh', false], ['refresh', true],
        ['wrapped', false], ['wrapped', true],
        ['flat', false], ['flat', true],
    ] as const)('retains %s cause with last-good catalog: %s', async (shape, retainGood) => {
        const cacheKey = `${shape}-${retainGood}`;
        const observedAt = Date.now() - 1_000;
        if (retainGood) cache.writeDynamicModelProbeCacheSuccess(cacheKey, { availableModels, supportsFreeform: false }, observedAt);
        const persistedBefore = window.localStorage.getItem('dynamic-model-probe-cache-v1');
        preflight.setCapabilityResponder(async () => {
            if (shape === 'wrapped') return { ok: false, error: {
                code: 'connected-service-preflight-failed', message: 'Preparation refused', failureCause,
            } };
            if (shape === 'flat') return { ok: false, error: 'Preparation refused',
                errorCode: 'connected-service-preflight-failed', failureCause };
            return { ok: true, result: AgentModelsProbeObservationSchema.parse({
                source: shape === 'unavailable' ? 'unavailable' : 'dynamic',
                availableModels: shape === 'unavailable' ? [] : availableModels,
                supportsFreeform: false, failureCause, refreshError: true, observedAt,
            }) };
        });
        const entry = await discoverMachineModels({ cacheKey, agentType: 'codex', machineId: 'machine-1',
            serverId: preflight.serverId, capabilityParams: {}, bypassCache: true });
        expect(entry).toMatchObject({ failureCause });
        if (retainGood) expect(entry).toMatchObject({ kind: 'success', updatedAt: observedAt, value: { availableModels } });
        else if (shape === 'flat' || shape === 'wrapped') expect(entry).toMatchObject({ kind: 'error' });
        else expect(entry).toMatchObject({ kind: 'success', value: { availableModels: shape === 'unavailable' ? [] : availableModels } });
        expect(window.localStorage.getItem('dynamic-model-probe-cache-v1')).toBe(persistedBefore);
    });
});
