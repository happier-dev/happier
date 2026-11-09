import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let featureEnabled = false;
const setPresets = vi.fn();

installSessionSettingsEntryModuleMocks({
    featureEnabled: (featureId) => featureId === 'sessions.lineageAppearancePresets' && featureEnabled,
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionLineageAppearancePresetsV1') {
                        return [{ future: 'keep', parent: { extra: 7 } }, setPresets];
                    }
                    if (key === 'sessionListDensity') return ['narrow', vi.fn()];
                    if (key === 'sessionListIdentityDisplay') return ['agentLogo', vi.fn()];
                    return [null, vi.fn()];
                }) as unknown as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    setPresets.mockClear();
    featureEnabled = false;
});

afterAll(() => {
    resetSessionSettingsEntryState();
});

describe('Session settings lineage appearance presets', () => {
    it('does not render or write preset controls while the experimental feature is off', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(mod.default));
        expect(screen.findAllByType('Item' as never)
            .some((node) => node.props?.testID === 'settings-session-lineage-appearance-entry')).toBe(false);
        expect(setPresets).not.toHaveBeenCalled();
    });

    it('links to one focused preset editor and edits parent and child presets while preserving unknown keys', async () => {
        featureEnabled = true;
        const mod = await import('../../../../app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const entry = screen.findAllByType('Item' as never)
            .find((node) => node.props?.testID === 'settings-session-lineage-appearance-entry');
        expect(entry).toBeDefined();
        expect(screen.findAllByType('DropdownMenu' as never)
            .some((node) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-lineage-parent-density-trigger')).toBe(false);
        await act(async () => entry?.props.onPress());
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/session/lineage-appearance');

        const editorMod = await import('../../../../app/(app)/settings/session/lineage-appearance');
        const editor = await renderSettingsView(React.createElement(editorMod.default));
        const dropdowns = editor.findAllByType('DropdownMenu' as never);
        const parentDensity = dropdowns.find((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-lineage-parent-density-trigger');
        const childAvatar = dropdowns.find((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-lineage-child-avatar-trigger');

        expect(parentDensity?.props.items.map((item: { id: string }) => item.id)).toEqual(['inherit', 'detailed', 'cozy', 'narrow']);
        expect(childAvatar?.props.items.length).toBeGreaterThan(3);
        await act(async () => parentDensity?.props.onSelect('cozy'));
        expect(setPresets).toHaveBeenLastCalledWith({ future: 'keep', parent: { extra: 7, density: 'cozy' } });
        await act(async () => childAvatar?.props.onSelect('gradient'));
        expect(setPresets).toHaveBeenLastCalledWith({
            future: 'keep',
            parent: { extra: 7 },
            child: { avatarStyle: 'gradient' },
        });
    });
});
