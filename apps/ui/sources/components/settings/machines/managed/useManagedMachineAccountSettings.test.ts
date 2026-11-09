import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actionAccountContext from '@/sync/ops/actions/actionAccountContext';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useManagedMachineAccountSettings } = await import('./useManagedMachineAccountSettings');
const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storageStore');
beforeEach(async () => { await harness.reset(); });
afterEach(() => { standardCleanup(); storage.getState().clearSettingsScope(); vi.restoreAllMocks(); });

describe('managed creation preferences on the addressed Account', () => {
    it('does zero reads or invalidations for another Home settings change, including during its own read', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://settings-scope.test', serverIdentityId: 'srv_settings_scope', accountId: 'settings-scope-owner' });
        const other = await harness.addHome({ name: 'Other', serverUrl: 'https://settings-other.test', serverIdentityId: 'srv_settings_other', accountId: 'settings-other-owner' });
        let releaseRead!: () => void;
        const held = new Promise<void>(resolve => { releaseRead = resolve; });
        const pendingRequest: { signal?: AbortSignal | null } = {};
        harness.answer(target, '/v2/account/settings', { select: (_input, request) => {
            pendingRequest.signal = request.signal;
            return { respondAfter: held, body: { content: { t: 'plain', v: settingsDefaults }, version: 1 } };
        } });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            const preferences = useManagedMachineAccountSettings(binding, resolution);
            useRenderCommitCounter(counter);
            return preferences;
        });
        try {
            await waitForHomeGovernance(() => expect(pendingRequest.signal).toBeDefined());
            const initialSignal = pendingRequest.signal;
            const reads = () => harness.requestsFor('/v2/account/settings').filter(request => request.serverId === target).length;
            const before = reads();
            counter.reset();
            for (let index = 0; index < 4; index++) {
                await act(async () => publishHomeAccountChange(other, ['self'], { changeKinds: ['account'] }));
                await flushHookEffects({ cycles: 30 });
            }
            expect({ reads: reads() - before, aborted: initialSignal?.aborted, ...counter.read() })
                .toEqual({ reads: 0, aborted: false, renders: 0, commits: 0 });
            releaseRead();
            await waitForHomeGovernance(() => expect(hook.getCurrent().settings).not.toBeNull());
            const previous = hook.getCurrent();
            counter.reset();
            await act(async () => publishHomeAccountChange(other, ['self'], { changeKinds: ['account'] }));
            await flushHookEffects({ cycles: 30 });
            expect(reads()).toBe(before);
            expect(hook.getCurrent()).toBe(previous);
            expect(counter.read()).toEqual({ renders: 0, commits: 0 });
            const nextEnabled = !settingsDefaults.managedMachineCreationEnabled;
            harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { ...settingsDefaults, managedMachineCreationEnabled: nextEnabled } }, version: 2 } });
            await act(async () => publishHomeAccountChange(target, ['self'], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.managedMachineCreationEnabled).toBe(nextEnabled));
            expect(reads()).toBe(before + 1);
        } finally { releaseRead(); await hook.unmount(); }
    });

    it('does no managed work for unrelated preferences and still receives either managed key', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'settings-cost-owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settingsDefaults }, version: 1 } });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            const preferences = useManagedMachineAccountSettings(binding, resolution);
            useRenderCommitCounter(counter);
            return { scope: binding?.scope, preferences };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings).not.toBeNull());
        const scope = hook.getCurrent().scope;
        if (!scope) throw new Error('Expected a bound Account scope');
        await act(async () => { saveAccountSettings(scope, settingsDefaults, 1); });
        await act(async () => { await storage.getState().activateSettingsScope(scope); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.loading).toBe(false));
        const previous = hook.getCurrent().preferences.settings;
        const reads = harness.requestsFor('/v2/account/settings').length;
        const captures = vi.spyOn(actionAccountContext, 'captureLazyActionAccountContext');
        counter.reset();
        for (let version = 2; version <= 33; version++) {
            await act(async () => {
                saveAccountSettings(scope, { ...settingsDefaults, analyticsOptOut: version % 2 === 0 }, version);
                publishHomeAccountChange(target, ['self'], { changeKinds: ['account'] });
                publishHomeAccountChange(target, ['unrelated-row'], { changeKinds: ['machine'] });
                publishHomeAccountChange(target, ['workflow-run:unrelated'], { changeKinds: ['account'], accountSettingsAffects: false });
            });
            await flushHookEffects();
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent().preferences.settings).toBe(previous);
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(reads);
        expect(captures).toHaveBeenCalledTimes(0);
        counter.reset();
        for (let index = 0; index < 3; index++) {
            await act(async () => { publishHomeAccountChange(target); });
            await flushHookEffects({ cycles: 30 });
        }
        // Focused Sync owns recovery; coarse Home wakes do no preference work here.
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent().preferences.settings).toBe(previous);
        captures.mockClear();
        const changed = { ...settingsDefaults, managedMachineCreationEnabled: !settingsDefaults.managedMachineCreationEnabled };
        await act(async () => { saveAccountSettings(scope, changed, 34); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(changed.managedMachineCreationEnabled));
        // A keyed local publication must not capture credentials or re-read the Account.
        expect(captures).toHaveBeenCalledTimes(0);
        const retention = { v: 1, local: { retention: { kind: 'unused', afterMs: 17_500, effect: 'stop' }, wakeOnAcceptedMessage: true } } as const;
        await act(async () => { saveAccountSettings(scope, { ...changed, machineRetentionDefaultsV1: retention }, 35); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.machineRetentionDefaultsV1).toEqual(retention));
        await act(async () => { await storage.getState().activateSettingsScope(scope); });
        await act(async () => { storage.getState().applySettingsLocal({ managedMachineCreationEnabled: settingsDefaults.managedMachineCreationEnabled }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(settingsDefaults.managedMachineCreationEnabled));
        await hook.unmount();
    });

    it('retains preferences while the replacement same-Account binding reads and receives its refreshed answer', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'settings-refresh-owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            const preferences = useManagedMachineAccountSettings(binding, resolution);
            return { binding, preferences };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(false));
        const firstBinding = hook.getCurrent().binding;
        let release: () => void = () => {};
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        harness.answer(target, '/v2/account/settings', { respondAfter, body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 2 } });
        await act(async () => { await harness.switchAccount(target, 'settings-refresh-owner', { currentAccount: true }); });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().binding).toBeDefined();
            expect(hook.getCurrent().binding).not.toBe(firstBinding);
            expect(hook.getCurrent().preferences.loading).toBe(true);
        });
        expect(firstBinding?.isCurrent()).toBe(false);
        expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(false);
        await act(async () => { release(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        await hook.unmount();
    });

    it('withdraws a refused read and recovers on the next unknown Home authority wake', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'settings-refusal-owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            return useManagedMachineAccountSettings(binding, resolution);
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ settings: null, loading: false, error: 'managed_settings_unavailable' }));
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
        await act(async () => { publishHomeAccountChange(target); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.managedMachineCreationEnabled).toBe(true));
        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        await act(async () => { publishHomeAccountChange(target); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ settings: null, loading: false, error: 'managed_settings_unavailable' }));
        await hook.unmount();
    });

    it('re-reads on a primary Home reconnect wake only while its last read failed', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'settings-reconnect-owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settingsDefaults }, version: 1 } });
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            return useManagedMachineAccountSettings(binding, resolution);
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings).not.toBeNull());
        const publishReconnectWake = async () => {
            await act(async () => { publishHomeAccountChange(target, undefined, { source: 'connected', changesCatchUp: true }); });
            await flushHookEffects({ cycles: 30 });
        };

        const currentReads = harness.requestsFor('/v2/account/settings').length;
        await publishReconnectWake();
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(currentReads);

        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        await act(async () => { publishHomeAccountChange(target); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().error).toBe('managed_settings_unavailable'));
        const failedReads = harness.requestsFor('/v2/account/settings').length;
        await publishReconnectWake();
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(failedReads + 1);
        await hook.unmount();
    });

    it('reads the saved Home rather than the focused Home and withdraws its preferences when custody retires', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const settings = { managedMachineCreationEnabled: false, machineRetentionDefaultsV1: { v: 1, local: {
            retention: { kind: 'unused', afterMs: 17_500, effect: 'stop' }, wakeOnAcceptedMessage: true,
        } } };
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            return { binding: binding?.scope, preferences: useManagedMachineAccountSettings(binding, resolution) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toMatchObject({ accountId: 'owner' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.loading).toBe(false));
        expect(hook.getCurrent().preferences).toMatchObject({ settings, loading: false, error: null });
        expect(harness.requestsFor('/v2/account/settings').every(request => request.serverId === target)).toBe(true);
        const savedPreferences = hook.getCurrent().preferences.settings;
        const settingsReads = harness.requestsFor('/v2/account/settings').length;
        for (const kind of ['session', 'machine'] as const) {
            await act(async () => publishHomeAccountChange(target, ['unrelated-row'], { changeKinds: [kind] }));
            await flushHookEffects();
        }
        await act(async () => publishHomeAccountChange(target, ['workflow-run:unrelated'], {
            changeKinds: ['account'], accountSettingsAffects: false,
        }));
        await flushHookEffects();
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(settingsReads);
        await act(async () => publishHomeAccountChange(target, ['approval-artifact'], { changeKinds: ['artifact'] }));
        await flushHookEffects();
        expect(hook.getCurrent().preferences.settings).toBe(savedPreferences);
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(settingsReads);
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { ...settings, managedMachineCreationEnabled: true } }, version: 2 } });
        await act(async () => publishHomeAccountChange(target, ['self'], { changeKinds: ['artifact', 'account'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 3 } });
        await act(async () => publishHomeAccountChange(target));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(false));
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { ...settings, managedMachineCreationEnabled: true } }, version: 4 } });
        await act(async () => publishHomeAccountChange(target, ['new-domain'], { changeKinds: ['artifact', 'future.domain'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        await act(async () => { await harness.switchAccount(target, 'replacement'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings).toBeNull());
        await hook.unmount();
    });

    it('keeps the binding and preferences when an unrelated Home profile changes', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner' });
        const settings = { managedMachineCreationEnabled: true, machineRetentionDefaultsV1: undefined };
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        // Every render of the consumer, so a one-frame withdrawal cannot slip between polls.
        const enabledByRender: boolean[] = [];
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            const preferences = useManagedMachineAccountSettings(binding, resolution);
            enabledByRender.push(preferences.settings?.managedMachineCreationEnabled === true);
            return { binding, preferences };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        const firstBinding = hook.getCurrent().binding;
        const firstEnabled = enabledByRender.indexOf(true);
        const reads = harness.requestsFor('/v2/account/settings').length;
        // Only the exact Home URL/credentials affect this binding, not a sibling profile.
        await act(async () => { await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' }); });
        await flushHookEffects();
        expect(hook.getCurrent().binding).toBe(firstBinding);
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(reads);
        expect(enabledByRender.slice(firstEnabled).every(Boolean)).toBe(true);
        await hook.unmount();
    });
});
