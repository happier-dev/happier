import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    workDepthLimit: 4,
    setWorkDepthLimit: vi.fn(),
    approvalReviewerEnabled: false,
    setApprovalReviewerEnabled: vi.fn(),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ View: 'View' });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: (key: string) => {
                if (key === 'workDepthLimit') return [shared.workDepthLimit, shared.setWorkDepthLimit];
                if (key === 'approvalReviewerEnabled') return [shared.approvalReviewerEnabled, shared.setApprovalReviewerEnabled];
                return [null, vi.fn()];
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (
                params && 'level' in params ? `${key}:${String(params.level)}` : key
            ),
        });
    },
});

const { DelegationSettingsView } = await import('./DelegationSettingsView');

describe('Settings › Delegation', () => {
    beforeEach(() => {
        shared.workDepthLimit = 4;
        shared.setWorkDepthLimit.mockReset();
        shared.approvalReviewerEnabled = false;
        shared.setApprovalReviewerEnabled.mockReset();
    });

    it('offers the default-off Account reviewer without changing the delegation depth', async () => {
        const screen = await renderSettingsView(<DelegationSettingsView />);
        await screen.pressByTestIdAsync('settings.delegation.approvalReviewerEnabled');
        expect(shared.setApprovalReviewerEnabled).toHaveBeenCalledWith(true);
        expect(shared.setWorkDepthLimit).not.toHaveBeenCalled();
    });

    it('lays out the ladder of the current limit and refuses the hand-off past it', async () => {
        const screen = await renderSettingsView(<DelegationSettingsView />);
        expect(screen.findRow('settings.delegation.ladder.root')).toBeTruthy();
        expect(screen.listRows('settings.delegation.ladder.level.').filter((node) => typeof node.type === 'string')
            .map((node) => node.props.testID)).toEqual([
            'settings.delegation.ladder.level.1',
            'settings.delegation.ladder.level.2',
            'settings.delegation.ladder.level.3',
            'settings.delegation.ladder.level.4',
        ]);
        expect(screen.findRow('settings.delegation.ladder.refused')?.props.accessibilityLabel)
            .toContain('roles.delegation.ladderRefusedDetail:5');
    });

    it('says something different on every ladder step: each level names the level that started it', async () => {
        const screen = await renderSettingsView(<DelegationSettingsView />);
        const details = [1, 2, 3, 4].map((level) => String(screen.findRow(`settings.delegation.ladder.level.${level}`)?.props.accessibilityLabel ?? ''));
        expect(details[0]).toContain('roles.delegation.ladderLevelDetail:1');
        expect(details[3]).toContain('roles.delegation.ladderLevelDetail:4');
        expect(new Set(details).size).toBe(4);
    });

    it('writes the chosen depth as the one Account limit', async () => {
        const screen = await renderSettingsView(<DelegationSettingsView />);
        await screen.pressByTestIdAsync('settings.delegation.workDepthLimit:2');
        expect(shared.setWorkDepthLimit).toHaveBeenCalledWith(2);
    });

    it('keeps a stored limit outside the offered depths visible and selected', async () => {
        shared.workDepthLimit = 8;
        const screen = await renderSettingsView(<DelegationSettingsView />);
        expect(screen.findRow('settings.delegation.workDepthLimit:8')).toBeTruthy();
        expect(screen.findRow('settings.delegation.ladder.refused')?.props.accessibilityLabel)
            .toContain('roles.delegation.ladderRefusedDetail:9');
    });
});
