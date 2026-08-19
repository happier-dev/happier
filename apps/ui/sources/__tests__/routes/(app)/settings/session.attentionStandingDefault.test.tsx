import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let attentionPromotionMode: string = 'off';
const setSessionListAttentionStandingDefault = vi.fn();

installSessionSettingsEntryModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionListAttentionPromotionModeV1') return [attentionPromotionMode, vi.fn()];
                    if (key === 'sessionListAttentionStandingDefaultV1') return [false, setSessionListAttentionStandingDefault];
                    return [null, vi.fn()];
                }) as any,
                useLocalSettingMutable: (() => [null, vi.fn()]) as any,
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    attentionPromotionMode = 'off';
    setSessionListAttentionStandingDefault.mockClear();
    resetSessionSettingsEntryState();
});

async function renderStandingItem() {
    const mod = await import('../../../../app/(app)/settings/session');
    const screen = await renderSettingsView(React.createElement(mod.default));
    return screen.findAllByType('Item' as any).find((node: any) =>
        node.props?.title === 'settingsSession.sessionList.attentionStandingDefaultTitle');
}

describe('Session settings attention standing default', () => {
    it('locks the switch and names the prerequisite while attention promotion is off', async () => {
        attentionPromotionMode = 'off';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(true);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultUnavailableSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(true);
    });

    it('enables the switch once attention promotion has a placement', async () => {
        attentionPromotionMode = 'global';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(false);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultDisabledSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(false);
    });
});
