import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let attentionPlacementMode: string = 'off';
let attentionStandingDefault: boolean = false;
const setSessionListAttentionStandingDefault = vi.fn();

installSessionSettingsEntryModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionListAttentionPromotionModeV1') return [attentionPlacementMode, vi.fn()];
                    if (key === 'sessionListAttentionStandingDefaultV1') return [attentionStandingDefault, setSessionListAttentionStandingDefault];
                    return [null, vi.fn()];
                }) as any,
                useLocalSettingMutable: (() => [null, vi.fn()]) as any,
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    attentionPlacementMode = 'off';
    attentionStandingDefault = false;
    setSessionListAttentionStandingDefault.mockClear();
    resetSessionSettingsEntryState();
});

async function renderStandingItem() {
    const mod = await import('@/app/(app)/settings/session');
    const screen = await renderSettingsView(React.createElement(mod.default));
    return screen.findAllByType('Item' as any).find((node: any) =>
        node.props?.testID === 'settings-session-attentionStandingDefault-item');
}

describe('Session settings attention standing default', () => {
    it('locks the switch and names the prerequisite while the attention band is off', async () => {
        attentionPlacementMode = 'off';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(true);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultUnavailableSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(true);
    });

    it('enables the switch once the attention band has a placement and writes the account default', async () => {
        attentionPlacementMode = 'global';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(false);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultDisabledSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(false);

        await act(async () => {
            item!.props.onPress();
        });

        expect(setSessionListAttentionStandingDefault).toHaveBeenCalledWith(true);
    });

    it('describes the enabled default when every session is kept', async () => {
        attentionPlacementMode = 'withinGroups';
        attentionStandingDefault = true;

        const item = await renderStandingItem();

        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultEnabledSubtitle');
        expect(item!.props.rightElement?.props?.value).toBe(true);
    });
});
