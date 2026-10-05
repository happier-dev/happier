import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import * as iosPolicies from './resolveIosActivitySurfacePolicies';

// Native widgets are an OS boundary. Web still mounts the same policy and settings subscriptions.
vi.mock('expo-widgets', () => ({ addUserInteractionListener: () => ({ remove() {} }) }));

describe('ActivitySurfacesRuntime settings subscriptions', () => {
    beforeEach(async () => {
        getPersistenceStorage().clearAll();
        await storage.getState().activateSettingsScope({ serverId: 'activity-home', accountId: 'activity-account' });
        storage.getState().applySettings(settingsDefaults, 1);
    });

    it('ignores unrelated account settings and refreshes for feature preferences', async () => {
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const commits = vi.fn();
        const resolvePolicies = vi.spyOn(iosPolicies, 'resolveIosActivitySurfacePolicies');
        await renderScreen(
            <React.Profiler id="activity-surfaces" onRender={commits}>
                <ActivitySurfacesRuntime />
            </React.Profiler>,
        );
        const baseline = commits.mock.calls.length;
        const computationBaseline = resolvePolicies.mock.calls.length;
        await act(async () => {
            storage.getState().applySettingsLocal({ favoriteDirectories: ['~/code'] });
        });
        expect(commits.mock.calls.length).toBe(baseline);
        expect(resolvePolicies.mock.calls.length).toBe(computationBaseline);
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
        });
        expect(commits.mock.calls.length).toBe(baseline + 1);
        expect(resolvePolicies.mock.calls.length).toBe(computationBaseline + 1);
    });
});
