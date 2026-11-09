import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import type { SessionModelDetailState } from './SessionModelDiscoveryDetail';
import { settingsParse } from '@/sync/domains/settings/settings';

const invoke = vi.hoisted(() => vi.fn());
// Action admission, discovery and cache remain real below the remote machine boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: invoke }));
const account = createProviderSettingsAccountHarness();
const { SessionModelDiscoveryDetail } = await import('./SessionModelDiscoveryDetail');
const { storage } = await import('@/sync/domains/state/storageStore');

const discovery = {
    backendTarget: { kind: 'backend' as const, backendId: 'codex' },
    selectedMachineId: 'machine-session', capabilityServerId: 'server-session', cwd: '/session',
    probeContext: { cacheKeySuffixParts: ['session-runtime'], capabilityParams: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } }, profileId: 'profile-session' } },

};
const result = (id: string) => ({ ok: true, result: { runtimeDescriptorV1Accepted: true, availableModels: [{ id, name: id }], supportsFreeform: false } });

describe('SessionModelDiscoveryDetail', () => {
    beforeEach(async () => {
        invoke.mockReset(); resetDynamicModelProbeCacheForTests();
        discovery.capabilityServerId = (await account.restore({ settings: { codexBackendMode: 'appServer' } })).serverId;
    });
    afterEach(async () => { await standardCleanup(); await account.reset(); });

    it('keeps declared Agent inputs current and performs no discovery work for unrelated Settings', async () => {
        const originalSettings = storage.getState().settings;
        storage.setState({ settings: settingsParse({ ...originalSettings, codexBackendMode: 'appServer' }) });
        let observedRuntime: unknown;
        let observedSettings: Readonly<Record<string, unknown>> | undefined;
        let discoveries = 0;
        const readDiscovery = (settings: Readonly<Record<string, unknown>>) => {
            discoveries++;
            observedSettings = settings;
            observedRuntime = settings.codexBackendMode;
            return { ...discovery, enabled: false, probeContext: { cacheKeySuffixParts: [String(observedRuntime)] } };
        };
        const screen = await renderScreen(<SessionModelDiscoveryDetail agentId="codex" composerOptionsInput={null}
            discovery={readDiscovery} renderDetail={() => null} />);
        try {
            await flushHookEffects();
            // The Agent behavior's configuredRuntimeSettingKeys declares this consumed view.
            expect(observedSettings).toEqual({ codexBackendMode: 'appServer' });
            expect(observedRuntime).toBe('appServer');
            const selected = observedSettings;
            const before = discoveries;
            await act(async () => {
                storage.setState((state) => ({ settings: { ...state.settings, showLineNumbers: !state.settings.showLineNumbers } }));
            });
            expect(observedSettings).toBe(selected);
            expect(discoveries - before).toBe(0);
            await act(async () => {
                storage.setState({ settings: settingsParse({ ...storage.getState().settings, codexBackendMode: 'acp' }) });
            });
            expect(observedSettings).toEqual({ codexBackendMode: 'acp' });
            expect(observedRuntime).toBe('acp');
            expect(discoveries - before).toBe(1);
        } finally {
            await screen.unmount();
            storage.setState({ settings: originalSettings });
        }
    });

    it('discovers only while mounted, keeps rows during forced refresh and passes the same catalog to selection validation', async () => {
        let state: SessionModelDetailState | undefined;
        let finish: ((value: ReturnType<typeof result>) => void) | undefined;
        invoke.mockResolvedValueOnce(result('fresh-1')).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const detail = <SessionModelDiscoveryDetail agentId="codex" composerOptionsInput={null} discovery={() => discovery} renderDetail={(next) => { state = next; return null; }} />;
        const screen = await renderScreen(<React.Fragment />);
        expect(invoke).not.toHaveBeenCalled();
        await screen.update(detail);
        await waitForHomeGovernance(() => expect(state?.modelOptions.some((option) => option.value === 'fresh-1')).toBe(true));
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(state?.modelOptions.some((option) => option.value === 'fresh-1')).toBe(true);
        expect(isModelSelectableForSession('codex', null, 'fresh-1', state?.modelOptionsContext)).toBe(true);
        await act(async () => { state?.probe?.onRefresh?.(); });
        expect(state?.modelOptions.some((option) => option.value === 'fresh-1')).toBe(true);
        await waitForHomeGovernance(() => expect(invoke.mock.calls[1]?.[0].payload.params.bypassCache).toBe(true));
        await act(async () => { finish?.(result('fresh-2')); });
        expect(state?.modelOptions.some((option) => option.value === 'fresh-2')).toBe(true);
        expect(invoke.mock.calls[0]?.[0]).toMatchObject({ machineId: 'machine-session',
            serverId: discovery.capabilityServerId, timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS });
        expect(invoke.mock.calls[0]?.[0].payload.params).toMatchObject({
            backendTarget: discovery.backendTarget, cwd: '/session',
            runtimeDescriptorV1: discovery.probeContext.capabilityParams.runtimeDescriptorV1, profileId: 'profile-session',
        });
        await screen.unmount();
    });
    it('stops transient retries when the detail closes and leaves read-only discovery idle', async () => {
        vi.useFakeTimers();
        try {
            invoke.mockResolvedValue({ ok: true, result: {
                runtimeDescriptorV1Accepted: true,
                availableModels: [{ id: 'temporary', name: 'Temporary' }], supportsFreeform: false,
                cacheable: false, source: 'static',
            } });
            const screen = await renderScreen(<SessionModelDiscoveryDetail agentId="codex" composerOptionsInput={null}
                discovery={() => discovery} renderDetail={() => null} />);
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            expect(invoke).toHaveBeenCalledTimes(1);
            await screen.update(<React.Fragment />);
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(invoke).toHaveBeenCalledTimes(1);
            await screen.update(<SessionModelDiscoveryDetail agentId="codex" composerOptionsInput={null}
                discovery={() => ({ ...discovery, enabled: false })} renderDetail={() => null} />);
            expect(invoke).toHaveBeenCalledTimes(1);
            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

});
