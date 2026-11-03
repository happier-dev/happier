import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { consumeWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
import { createPluginOpenAutomationEventHandler } from './pluginOpenAutomationEventHostApi';
import { readAutomationEventAuthoringSeed } from '@/sync/domains/workflows/automationEventAuthoringSeed';

const lifetime = { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
    onRetire: () => ({ dispose() {} }) };
const seed = { eventRef: { pluginId: 'com.acme.source', localId: 'deployment-review' },
    monitoringMachineId: 'monitor', connectedAccount: {
        service: { pluginId: 'com.acme.source', localId: 'account' }, accountId: 'selected-account',
    }, setupInput: { repository: 'acme/widgets' } };
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previousState = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerSnapshot({ serverId: 'home', serverUrl: 'https://automation-open.test', generation: 1 });
    storage.setState({ profileScope: lifetime.scope });
});
afterEach(() => {
    storage.setState(previousState);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

describe('Automation Event host navigation', () => {
    it.each([seed, { eventRef: seed.eventRef, setupInput: seed.setupInput },
        { ...seed, sourceInstanceId: 'repository:acme/widgets' }])('hands a complete or partial private seed to the existing Account trigger owner using only an opaque route handle: %j', async (intent) => {
        const navigate = vi.fn<NonNullable<Parameters<typeof createPluginOpenAutomationEventHandler>[0]['navigate']>>();
        const open = createPluginOpenAutomationEventHandler({ accountLifetime: lifetime, isCurrent: () => true, navigate });
        expect(await open(intent)).toBeNull();
        expect(navigate).toHaveBeenCalledTimes(1);
        const route = navigate.mock.calls[0]![0];
        expect(route.pathname).toBe('/workflows');
        expect(Object.keys(route.params).sort()).toEqual(['automationEventSeedId', 'serverId']);
        expect(readAutomationEventAuthoringSeed(route.params.automationEventSeedId, lifetime.scope)).toEqual(intent);
        expect(readAutomationEventAuthoringSeed(route.params.automationEventSeedId, { serverId: 'other', accountId: 'account' })).toBeNull();
        consumeWorkflowEditorDraftSeed(route.params.automationEventSeedId);
    });

    it('does no navigation for a retired mount, a cancelled request or an invalid seed', async () => {
        const navigate = vi.fn();
        const controller = new AbortController();
        controller.abort();
        const open = createPluginOpenAutomationEventHandler({ accountLifetime: lifetime, isCurrent: () => true, navigate });
        expect(await open(seed, { signal: controller.signal })).toMatchObject({ code: 'unavailable' });
        expect(await open({ ...seed, monitoringMachineId: '' })).toMatchObject({ code: 'invalid_payload' });
        const retired = createPluginOpenAutomationEventHandler({ accountLifetime: lifetime, isCurrent: () => false, navigate });
        expect(await retired(seed)).toMatchObject({ code: 'stale_surface' });
        expect(navigate).not.toHaveBeenCalled();
    });
    it('rejects an addressed nonactive Account before navigation', async () => {
        const navigate = vi.fn();
        const open = createPluginOpenAutomationEventHandler({ accountLifetime: {
            ...lifetime, scope: { serverId: 'different-home', accountId: 'different-account' },
        }, isCurrent: () => true, navigate });
        expect(await open(seed)).toMatchObject({ code: 'unavailable', diagnostics: ['automation_event_active_account_required'] });
        expect(navigate).not.toHaveBeenCalled();
    });
});
