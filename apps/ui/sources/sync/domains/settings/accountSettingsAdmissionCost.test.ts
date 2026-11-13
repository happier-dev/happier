import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { settingsParse } from './settings';
import { normalizeAccountSettingsForLocalStorage } from './accountSettingsNormalization';
import { reconcileSettingsReferences } from './reconcileSettingsReferences';
import { resolveActionsSettingsV1FromState } from './actionsSettings';

const rawPolicy = { v: 1, actions: {
    'happier.scm.git/actions/status': { enabled: false },
    'session.stop': { approvalRequiredSurfaces: ['ui'] },
} };

// Observe the real projection through the strict JSON walker’s reflection boundary; never replace its decision.
async function countPolicyProjections(run: () => void | Promise<void>): Promise<number> {
    const descriptors = Object.getOwnPropertyDescriptors;
    let count = 0;
    const observer = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation(value => {
        if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'pluginId') && Object.hasOwn(value, 'localId')) count++;
        return descriptors(value);
    });
    try { await run(); } finally { observer.mockRestore(); }
    return count;
}

describe('Account settings policy admission cost', async () => {
    it('projects policy once when an incoming glass write is opened, without reading Account policy from the local snapshot', async () => {
        const local = settingsParse({ actionsSettingsV1: rawPolicy,
            serverSelectionGroups: [{ id: 'group', name: 'My machines', serverIds: ['home'] }] });
        let result = local;
        const oneAdmission = await countPolicyProjections(() => { ActionsSettingsV1Schema.parse(rawPolicy); });
        const projections = await countPolicyProjections(() => {
            result = normalizeAccountSettingsForLocalStorage({
                raw: { actionsSettingsV1: rawPolicy, glassBlurEnabled: false },
                mode: 'plain', settingsSecretsKey: null, localSettings: local,
            });
        });
        expect(result.glassBlurEnabled).toBe(false);
        expect(result.serverSelectionGroups).toEqual(local.serverSelectionGroups);
        expect(result.actionsSettingsV1.actions['happier.scm.git/actions/status']?.enabled).toBe(false);
        expect(oneAdmission).toBeGreaterThan(0);
        expect(projections).toBe(oneAdmission);
    });

    it('reconciles admitted policy without projecting it again after an unrelated write', async () => {
        const previous = settingsParse({ actionsSettingsV1: rawPolicy });
        const incoming = settingsParse({ actionsSettingsV1: rawPolicy, glassBlurEnabled: false });
        let result = previous;
        const projections = await countPolicyProjections(() => {
            result = reconcileSettingsReferences(previous, incoming);
        });
        expect(result.actionsSettingsV1).toBe(previous.actionsSettingsV1);
        expect(result.glassBlurEnabled).toBe(false);
        expect(projections).toBe(0);
    });

    it('reads admitted policy without projecting it during unrelated renders', async () => {
        const settings = settingsParse({ actionsSettingsV1: rawPolicy });
        const projections = await countPolicyProjections(async () => {
            const hook = await renderHook((glassBlurEnabled: boolean) =>
                resolveActionsSettingsV1FromState({ settings: { ...settings, glassBlurEnabled } }),
            { initialProps: true });
            try {
                expect(hook.getCurrent()).toBe(settings.actionsSettingsV1);
                await hook.rerender(false);
                expect(hook.getCurrent()).toBe(settings.actionsSettingsV1);
            } finally { await hook.unmount(); }
        });
        expect(projections).toBe(0);
    });
});
