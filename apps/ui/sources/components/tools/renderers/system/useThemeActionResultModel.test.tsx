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
import { prepareThemeCss } from '@/theme/css/prepareThemeCss';
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
                coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
                detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
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
        const hook = await renderHook(() => useThemeActionResultModel(presentation,
            { preview: state.owner, entry: null, created: true, here: 'here' }, execute));
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
        await hook.unmount();
    });
});
