import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { THEME_ACTION_IDS, ThemeActionOutputSchemas, type ThemeActionRequest, type ThemeActionId, type ThemeActionInput, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createThemeActionHarness, themeActionDocument } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useThemeLibraryModel, type ThemeLibraryModelInput } from './useThemeLibraryModel';
import type { ThemeUiActionExecute } from './useThemeActionExecution';
import { buildThemePresetSourceOptions } from './themeProfilePresetOptions';
import { createThemePluginShareForm } from './themePluginShareForm';
import { createShareThemePlugin } from '@/theme/profiles/shareThemePlugin';

describe('theme library controller', () => {
    it('browses headers without bodies and applies through policy without changing the other mode', async () => {
        const state = createThemeActionHarness();
        const saved = (await state.library.save({ document: themeActionDocument('Header') })).entry!;
        let settings = normalizeActionsSettingsV1({ v: 1, actions: { [THEME_ACTION_IDS.apply]: { disabledSurfaces: ['ui'] } } });
        const executor = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(state.library), readSelection: () => state.selection, clientId: () => '',
        }), isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings, context) });
        async function execute<Id extends ThemeActionId>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> {
            const result = await executor.execute(id, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            requireActionSuccess(result);
            return ThemeActionOutputSchemas[id].parse(result.result) as ThemeActionOutput<Id>;
        }
        const failure = vi.fn();
        const props: ThemeLibraryModelInput = { labels: { sourceYours: 'Made by you', sourceStore: 'Store', sourcePlugin: 'Plugin', editTheme: 'Edit', exportFile: 'Export file' }, options: [
            { id: 'light', kind: 'base', title: 'Light', subtitle: '', preferredMode: 'light', profile: null, reference: null },
            { id: 'dark', kind: 'base', title: 'Dark', subtitle: '', preferredMode: 'dark', profile: null, reference: null },
            { id: 'header', kind: 'custom', title: saved.name, subtitle: '', preferredMode: saved.mode,
                profile: null, reference: saved.reference, miniature: saved.miniature, entry: saved },
        ], selection: state.selection, showing: saved.mode, retry: () => {}, onCreate: () => {},
            onEdit: () => {}, onExport: () => {}, onImport: () => {}, onFailure: failure };
        const hook = await renderHook(input => useThemeLibraryModel(input, execute), { initialProps: props });
        expect(hook.getCurrent().tiles.find(tile => tile.key === 'header')?.preview.kind).toBe('miniature');
        const otherMode = saved.mode === 'light' ? 'dark' : 'light';
        const otherBefore = state.selection[otherMode];
        await act(async () => hook.getCurrent().onChooseTheme('header'));
        await vi.waitFor(() => expect(failure).toHaveBeenCalled());
        expect(state.selection[saved.mode]).toBeNull();
        settings = normalizeActionsSettingsV1({ v: 1 });
        await act(async () => hook.getCurrent().onChooseTheme('header'));
        await vi.waitFor(() => expect(state.selection[saved.mode]).toEqual(saved.reference));
        expect(state.selection[otherMode]).toBe(otherBefore);
        await hook.rerender({ ...props, selection: state.selection });
        expect(hook.getCurrent().selectedKey).toBe('header');
        await act(async () => hook.getCurrent().onChooseTheme(saved.mode));
        await vi.waitFor(() => expect(state.selection[saved.mode]).toBeNull());
        expect(state.selection[otherMode]).toBe(otherBefore);
        await hook.unmount();
    });
});

describe('theme library Share controller', () => {
    it('shares an editable header through an explicit Machine form and leaves base themes without Share', async () => {
        const harness = createThemeActionHarness();
        const saved = (await harness.library.save({ document: themeActionDocument('Header') })).entry!;
        const forms: ReturnType<typeof createThemePluginShareForm>[] = [];
        const share = createShareThemePlugin(harness.library);
        const executeTheme = createThemeActionExecute({ withLibrary: operation => operation(harness.library),
            clientId: () => 'this-client', readSelection: () => harness.selection });
        const execute: ThemeUiActionExecute = async (actionId, input) => {
            const result = await executeTheme({ actionId, input, context: { surface: 'ui' } } as ThemeActionRequest);
            if ('errorCode' in result) throw new Error(result.errorCode);
            return result as ThemeActionOutput<typeof actionId>;
        };
        const input: ThemeLibraryModelInput = {
            options: buildThemePresetSourceOptions(await harness.library.list()), selection: harness.selection,
            showing: saved.mode,
            labels: { sourceYours: 'Yours', sourceStore: 'Store', sourcePlugin: 'Plugin', editTheme: 'Edit', exportFile: 'Export' },
            retry() {}, onCreate() {}, onEdit() {}, onExport() {}, onImport() {},
            onShare: reference => forms.push(createThemePluginShareForm({ refs: [reference], serverId: 'home',
                labels: { share: 'Share', machine: 'Machine', path: 'Path' }, execute: async (actionId, input) => {
                    const result = await share({ actionId, input, context: { hostReviewedChild: { invoke: async request =>
                        request.action === 'plugins.scaffold' ? { ok: true, result: { ok: true, createdPaths: { targetDir: '/chosen' } } }
                            : { ok: true, result: { ok: true, package: { archivePath: '/chosen.tgz', archiveDigest: 'digest' } } } } } });
                    if ('ok' in result) throw new Error(result.errorCode);
                    return result;
                } })),
        };
        const hook = await renderHook(value => useThemeLibraryModel(value, execute), { initialProps: input });
        expect(hook.getCurrent().tiles.find(tile => tile.key === saved.mode)?.onShare).toBeUndefined();
        const shareTheme = hook.getCurrent().tiles.find(tile => tile.name === saved.name)?.onShare;
        expect(shareTheme).toBeDefined();
        await act(async () => { shareTheme?.(); });
        const form = forms[0]!;
        expect(form.getInput()).toEqual({});
        form.replaceInput({ machine: { serverId: 'home', machineId: 'chosen-machine' }, path: '/chosen' });
        expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true,
            shared: { project: '/chosen', archive: '/chosen.tgz', digest: 'digest' } } });
        form.retire();
        await hook.unmount();
    });
});
