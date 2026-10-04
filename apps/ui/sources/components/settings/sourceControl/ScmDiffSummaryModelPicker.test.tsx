import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ScmDiffSummaryModelPicker } from './ScmDiffSummaryModelPicker';
import { decodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { getStorage } from '@/sync/domains/state/storage';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const rpc = vi.hoisted(() => ({ invoke: vi.fn() }));
// The daemon RPC is the system boundary; catalog, discovery/cache, hook and picker stay real.
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: rpc.invoke }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('Summary model discovery', () => {
    const initialStorage = getStorage().getState();
    beforeEach(() => { rpc.invoke.mockReset(); resetDynamicModelProbeCacheForTests(); });
    afterEach(() => { standardCleanup(); getStorage().setState(initialStorage, true); });
    it.each([
        { name: 'Codex', id: 'backend-discovery:agent:happier.agent.codex/codex', target: { kind: 'backend', backendId: 'codex' }, configured: false, unknownStatic: false },
        { name: 'configured ACP', id: 'backend-discovery:backend:review-bot:configured:review-bot', target: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }, configured: true, unknownStatic: false },
        { name: 'configured carrier with only unknown static models', id: 'backend-discovery:backend:claude:configured:claude', target: { kind: 'backend', backendId: 'claude', configuredBackendId: 'claude' }, configured: true, unknownStatic: true },
    ])('discovers $name without saving a fabricated model choice', async ({ id, target, configured, unknownStatic }) => {
        if (configured) getStorage().setState({ settings: { ...initialStorage.settings, acpCatalogSettingsV1: {
            v: 2, backends: [{ id: target.backendId, name: target.backendId, title: 'Review Bot', command: 'review-cli', args: ['acp'], env: {},
                capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
                createdAt: 1, updatedAt: 1 }],
        } } });
        rpc.invoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
            availableModels: [
                { id: 'real-model', name: 'Real model', capabilities: { structuredOutput: 'supported' } },
                { id: 'rejected-model', name: 'Rejected model', capabilities: { structuredOutput: 'unsupported' } },
            ], supportsFreeform: false, source: 'dynamic',
        } } });
        const change = vi.fn();
        const selection = vi.fn();
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={change}
            onSelection={selection} machineId="summary-discovery-machine" serverId="summary-discovery-home" />);
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        if (unknownStatic) {
            const staticRows = menu().props.items.filter((item: { category: string; id: string }) => item.category === 'Review Bot' && item.id !== id);
            expect(staticRows.length).toBeGreaterThan(0);
            expect(staticRows.every((item: { disabled: boolean }) => item.disabled)).toBe(true);
        }
        const discovery = menu().props.items.find((item: { id: string }) => item.id === id);
        expect(discovery).toBeDefined();
        await act(async () => { menu().props.onSelect(discovery.id); });
        expect(change).not.toHaveBeenCalled();
        expect(selection).not.toHaveBeenCalled();
        expect(rpc.invoke).toHaveBeenCalledWith('summary-discovery-machine', expect.objectContaining({
            method: 'probeModels', params: expect.objectContaining({ backendTarget: expect.objectContaining(target) }),
        }), expect.objectContaining({ serverId: 'summary-discovery-home' }));
        const offered = menu().props.items.find((item: { title: string }) => item.title === 'Real model');
        const rejected = menu().props.items.find((item: { title: string }) => item.title === 'Rejected model');
        expect(offered?.disabled).toBe(false);
        expect(rejected?.disabled).toBe(true);
        await act(async () => { menu().props.onSelect(rejected.id); });
        expect(change).not.toHaveBeenCalled();
        await act(async () => { menu().props.onSelect(offered.id); });
        expect(decodeScmDiffSummaryModelOverride(change.mock.calls[0]?.[0])).toMatchObject({ modelId: 'real-model' });
        expect(selection).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: expect.objectContaining(target), modelSelector: expect.objectContaining({ modelId: 'real-model' }),
        }));
        await screen.unmount();
    });
});
