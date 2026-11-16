import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { THEME_ACTION_IDS, ThemeActionInputSchemas, ThemeActionOutputSchemas,
    type ThemeActionId, type ThemeActionInput, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { makeToolCall } from '@/dev/testkit';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createThemeActionHarness, themeActionDocument } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { readThemeActionCardPresentation } from '@/components/sessions/transcript/references/transcriptThemeAction';
import { prepareThemeProfileCss } from '@/theme/css/prepareThemeCss';
import { projectThemeMiniature } from '@/theme/profiles/themeProfilePresentation';
import { useThemeActionResultModel } from './useThemeActionResultModel';

describe('theme proposal card controller', () => {
    it('tries A/B/A without writes, keeps only A, then Undo/Redo replay preserves siblings and raw presentation', async () => {
        const state = createThemeActionHarness();
        const sibling = await state.library.save({ document: themeActionDocument('Sibling') });
        const writesBefore = state.writes();
        const siblingRaw = state.rows.get(sibling.entry!.id)!.document.raw;
        const executor = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(state.library), readSelection: () => state.selection, clientId: () => '',
            runtime: { preview: state.owner,
                coverage: document => prepareThemeProfileCss(document.profile).coverage,
                detailedCoverage: document => prepareThemeProfileCss(document.profile).detailedCoverage,
                surfaceMap: () => [] },
        }) });
        async function execute<Id extends ThemeActionId>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> {
            const result = await executor.execute(id, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            requireActionSuccess(result);
            // The catalog has already admitted this id's result; its schema also builds the transcript fixture.
            return ThemeActionOutputSchemas[id].parse(result.result) as ThemeActionOutput<Id>;
        }
        const messages = [];
        for (const name of ['A', 'B', 'C']) {
            const input = ThemeActionInputSchemas[THEME_ACTION_IDS.tryOn].parse({ document: themeActionDocument(name),
                mode: 'dark', origin: { kind: 'agent' }, group: 'options' });
            const output = await execute(THEME_ACTION_IDS.tryOn, input);
            messages.push(createToolCallMessageFixture({ id: name, tool: makeToolCall({ id: name, name: 'mcp__happier__action_execute',
                state: 'completed', input: { actionId: THEME_ACTION_IDS.tryOn, input }, result: { ok: true, result: output } }) }));
        }
        const last = messages.at(-1)!;
        const presentation = readThemeActionCardPresentation({ tool: last.tool, messages, messageId: last.id });
        expect(presentation?.options).toHaveLength(3);
        expect(readThemeActionCardPresentation({ tool: messages[0]!.tool, messages, messageId: 'A' })?.visible).toBe(false);
        if (!presentation) throw new Error('Missing card');
        const distribute = vi.fn();
        const edit = vi.fn();
        const hook = await renderHook(() => useThemeActionResultModel(presentation,
            { preview: state.owner, entry: null, created: true, here: 'here', onUseOtherDevices: distribute, onEdit: edit }, execute));
        hook.getCurrent()!.onEdit!();
        expect(edit).toHaveBeenCalledWith({ kind: 'document', document: presentation.options.at(-1)!.call.input.document });
        for (const key of ['A', 'B', 'A']) {
            await act(async () => hook.getCurrent()!.onTryOption(key));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ theme: { name: key }, currentOptionKey: key, busy: null }));
        }
        expect(state.writes()).toBe(writesBefore);
        await act(async () => hook.getCurrent()!.onKeep());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('kept'));
        expect(state.writes()).toBe(writesBefore + 1);
        expect([...state.rows.values()].map(row => row.document.profile.name).sort()).toEqual(['A', 'Sibling']);
        expect([...state.rows.values()].find(row => row.document.profile.name === 'A')!.document.raw.style).toEqual({ futurePresentation: { glow: true } });
        await act(async () => hook.getCurrent()!.onUndo());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('undone'));
        expect([...state.rows.keys()]).toEqual([sibling.entry!.id]);
        await act(async () => hook.getCurrent()!.onRedo());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('kept'));
        expect([...state.rows.values()].map(row => row.document.profile.name).sort()).toEqual(['A', 'Sibling']);
        expect(state.rows.get(sibling.entry!.id)!.document.raw).toBe(siblingRaw);
        await act(async () => { state.owner.begin({ document: themeActionDocument('replacement'), mode: 'dark', origin: { kind: 'editor' } }); });
        await act(async () => hook.getCurrent()!.onUndo());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('undone'));
        await act(async () => hook.getCurrent()!.onTryOption('B'));
        await vi.waitFor(() => expect(hook.getCurrent()?.theme.name).toBe('B'));
        await act(async () => { state.owner.begin({ document: themeActionDocument('newer'), mode: 'dark', origin: { kind: 'editor' } }); });
        await act(async () => hook.getCurrent()!.onKeep());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase).toMatchObject({ kind: 'failed', operation: 'keep', code: 'theme_preview_stale' }));
        await act(async () => hook.getCurrent()!.onRetry());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('kept'));
        expect(hook.getCurrent()?.theme.name).toBe('B');
        hook.getCurrent()!.onUseOtherDevices!();
        expect(distribute).toHaveBeenCalledWith({ reference: state.selection.dark, mode: 'dark', name: 'B' });
        hook.getCurrent()!.onEdit!();
        expect(edit).toHaveBeenCalledWith({ kind: 'entry', entry: expect.objectContaining({ reference: state.selection.dark, name: 'B' }) });
        expect(state.rows.get(sibling.entry!.id)!.document.raw).toBe(siblingRaw);
        await hook.unmount();
    });

    it('shows a base theme Apply without a library entry and retains its null reference through Undo and Redo', async () => {
        const state = createThemeActionHarness();
        const saved = (await state.library.save({ document: themeActionDocument('Previous') })).entry!;
        await state.library.select({ reference: saved.reference, mode: 'light' });
        const executor = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(state.library), readSelection: () => state.selection, clientId: () => '',
        }) });
        async function execute<Id extends ThemeActionId>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> {
            const result = await executor.execute(id, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            requireActionSuccess(result);
            return ThemeActionOutputSchemas[id].parse(result.result) as ThemeActionOutput<Id>;
        }
        const input = { ref: null, mode: 'light' as const };
        const output = await execute(THEME_ACTION_IDS.apply, input);
        const message = createToolCallMessageFixture({ id: 'base', tool: makeToolCall({ id: 'base', name: 'mcp__happier__action_execute',
            state: 'completed', input: { actionId: THEME_ACTION_IDS.apply, input }, result: { ok: true, result: output } }) });
        const presentation = readThemeActionCardPresentation({ tool: message.tool, messages: [message], messageId: message.id });
        if (!presentation) throw new Error('Missing base Apply card');
        const distribute = vi.fn();
        const miniature = projectThemeMiniature({ overrides: { light: {}, dark: {} }, assetAppearance: 'light' });
        const facts = { preview: state.owner, entry: null, created: false, here: 'here',
            appliedTheme: { name: 'Base', mode: 'light' as const, miniature }, onUseOtherDevices: distribute, onEdit: vi.fn() };
        const hook = await renderHook(() => useThemeActionResultModel(presentation, facts, execute));
        expect(hook.getCurrent()).toMatchObject({ theme: { name: 'Base', mode: 'light', miniature }, phase: { kind: 'applied' } });
        expect(hook.getCurrent()?.onEdit).toBeUndefined();
        hook.getCurrent()!.onUseOtherDevices!();
        expect(distribute).toHaveBeenCalledWith({ reference: null, mode: 'light', name: 'Base' });
        await act(async () => hook.getCurrent()!.onUndo());
        await vi.waitFor(() => expect(state.selection.light).toEqual(saved.reference));
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('undone'));
        await act(async () => hook.getCurrent()!.onRedo());
        await vi.waitFor(() => expect(hook.getCurrent()?.phase.kind).toBe('applied'));
        expect(state.selection.light).toBeNull();
        expect(state.writes()).toBe(1);
        await hook.unmount();
    });
});
