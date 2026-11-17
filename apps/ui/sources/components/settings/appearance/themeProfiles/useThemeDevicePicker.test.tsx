import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { THEME_ACTION_IDS, ThemeActionOutputSchemas, type ThemeActionId,
    type ThemeActionInput, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createThemeActionHarness } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useThemeDevicePicker, type ThemeDevicePickerInput } from './useThemeDevicePicker';

describe('shared theme connected-device picker', () => {
    it('discovers only on open, dispatches each chosen target once and exposes a disconnected target', async () => {
        const state = createThemeActionHarness();
        const reads: string[] = [];
        const targets: string[] = [];
        // App-to-app RPC is the genuine transport boundary; its declared Action schemas build each receipt.
        const executor = createActionExecutor({ clientActionExecute: async request => {
            const target = typeof request.input === 'object' && request.input !== null && 'clientId' in request.input
                ? request.input.clientId : undefined;
            if (!target || target === 'self') return request.execute();
            targets.push(String(target));
            if (target === 'gone') return { ok: false as const, errorCode: 'client_not_connected', error: 'client_not_connected' };
            return { ok: true as const, result: ThemeActionOutputSchemas[THEME_ACTION_IDS.apply].parse({
                applied: { clientId: target, mode: 'dark' }, undoHandle: 'remote',
            }) };
        }, themeAction: createThemeActionExecute({
            withLibrary: operation => operation(state.library), readSelection: () => state.selection, clientId: () => 'self',
            dispatchClientAction: async request => {
                if (request.actionId === THEME_ACTION_IDS.list) {
                    reads.push('list');
                    return ThemeActionOutputSchemas[THEME_ACTION_IDS.list].parse({ themes: [], devices: [
                        { id: 'phone', deviceLabel: 'Phone', state: { computer: false, focused: true } },
                        { id: 'self', deviceLabel: 'Computer', state: { computer: true, focused: false } },
                        { id: 'gone', deviceLabel: null },
                    ] });
                }
                throw new Error('Remote apply must use the canonical client Action transport');
            },
        }) });
        async function execute<Id extends ThemeActionId>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> {
            const result = await executor.execute(id, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            requireActionSuccess(result);
            return ThemeActionOutputSchemas[id].parse(result.result) as ThemeActionOutput<Id>;
        }
        const distributed = vi.fn();
        const props: ThemeDevicePickerInput = { enabled: false, theme: { reference: null, name: 'Base', mode: 'dark' },
            currentClientId: 'self', unnamedDeviceLabel: 'Unnamed device', onDismiss: () => {}, onDistribution: distributed };
        const hook = await renderHook(input => useThemeDevicePicker(input, execute), { initialProps: props });
        expect(reads).toEqual([]);
        await hook.rerender({ ...props, enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().rows.map(row => row.id)).toEqual(['self', 'phone', 'gone']));
        expect(reads).toEqual(['list']);
        expect(hook.getCurrent().rows.filter(row => row.checked).map(row => row.id)).toEqual(['phone', 'gone']);
        await act(async () => { hook.getCurrent().onToggle('self'); });
        expect(hook.getCurrent().rows.find(row => row.current)?.checked).toBe(false);
        await act(async () => hook.getCurrent().onUse());
        await vi.waitFor(() => expect(hook.getCurrent().dispatching).toBe(false));
        expect(targets.sort()).toEqual(['gone', 'phone']);
        expect(hook.getCurrent().rows.find(row => row.id === 'gone')?.outcome).toBe('disconnected');
        expect(distributed).toHaveBeenCalledWith({ applied: ['Phone'], failed: [{ label: expect.any(String), reason: 'disconnected' }] });
        expect(state.writes()).toBe(0);
        await hook.rerender(props);
        expect(reads).toEqual(['list']);
        await hook.unmount();
    });
});
