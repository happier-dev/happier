import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useSessionAuthoringControls, type SessionAuthoringControlsInput } from './useSessionAuthoringControls';

const modeOptions = [
    { id: 'default', name: 'Native Default' },
    { id: 'plan', name: 'Plan' },
    { id: 'auto', name: 'Auto' },
    { id: 'dontAsk', name: "Don't ask" },
];

function modeInput(extra: Partial<SessionAuthoringControlsInput> = {}): SessionAuthoringControlsInput {
    return {
        agentId: 'codebuddy',
        canChangeModel: false,
        canChangeSessionMode: true,
        canChangeConfigOption: false,
        ...extra,
    };
}

describe('useSessionAuthoringControls session modes', () => {
    it.each([null, 'default'] as const)('distinguishes preflight unset from native Default (%s)', async (modeId) => {
        const hook = await renderHook(() => useSessionAuthoringControls(modeInput({
            acpSessionModeOptionsOverride: modeOptions,
            acpSessionModeSelectedIdOverride: modeId,
        })));
        expect(hook.getCurrent().sessionModeChipControl?.selectedId).toBe(modeId ?? '');
        expect(hook.getCurrent().sessionModePickerOptions.map((option) => option.id))
            .toEqual(['', 'default', 'plan', 'auto', 'dontAsk']);
        await hook.unmount();
    });

    it.each([null, 'default'] as const)('selects live override intent independently of reported mode (%s)', async (modeId) => {
        const hook = await renderHook(() => useSessionAuthoringControls(modeInput({
            metadata: {
                path: '/tmp', host: 'test-host', flavor: 'codebuddy',
                sessionModesV2: {
                    v: 2, agentId: 'codebuddy', updatedAt: 1, currentModeId: 'auto',
                    availableModes: modeOptions,
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId },
            },
        })));
        expect(hook.getCurrent().sessionModeChipControl?.selectedId).toBe(modeId ?? '');
        expect(hook.getCurrent().sessionModeChipControl?.label).toBe(modeId === null ? 'Auto' : 'Native Default');
        expect(hook.getCurrent().effectivePermissionPolicy.nativeModeLabel).toBe('Auto');
        await hook.unmount();
    });

    it('cycles the same mapped choices offered by the picker', async () => {
        const hook = await renderHook(() => useSessionAuthoringControls(modeInput({
            acpSessionModeOptionsOverride: modeOptions.slice(0, 2),
            acpSessionModeSelectedIdOverride: 'plan',
        })));
        expect(hook.getCurrent().sessionModeChipInteraction).toMatchObject({
            kind: 'cycle', selectableOptionIds: ['', 'default', 'plan'], nextOptionId: '',
        });
        await hook.unmount();
    });

    it('selects the existing default clear sentinel when the live provider has no native default', async () => {
        const hook = await renderHook(() => useSessionAuthoringControls(modeInput({
            agentId: 'opencode',
            metadata: {
                path: '/tmp', host: 'test-host', flavor: 'opencode',
                sessionModesV2: {
                    v: 2, agentId: 'opencode', updatedAt: 1, currentModeId: 'build',
                    availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
                },
                sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: null },
            },
        })));
        expect(hook.getCurrent().sessionModeChipControl?.selectedId).toBe('default');
        expect(hook.getCurrent().sessionModeChipControl?.label).toBe('Build');
        expect(hook.getCurrent().sessionModeChipInteraction).toMatchObject({ kind: 'cycle', nextOptionId: 'build' });
        await hook.unmount();
    });
});
