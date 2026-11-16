import { describe, expect, it } from 'vitest';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { ThemeActionInputSchemas, ThemeActionOutputSchemas, type ThemeActionInput, type ThemeActionOutput, type ThemeActionRequest } from '@happier-dev/protocol/actions/themeActionFamily';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeActionId } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { createThemeActionHarness } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { prepareThemeCss } from '@/theme/css/prepareThemeCss';
import { createThemeProfileEditorActions, type ThemeEditorExecute } from './themeProfileEditorActions';

function fixture() {
    const parsed = parseThemeProfileDocument({ ...createThemeProfileDraft({ id: '11111111-1111-4111-8111-111111111111', name: 'Retained theme', now: '2026-11-16T12:00:00.000Z' }),
        schemaVersion: 2, style: { radius: 'soft', futureInset: 12 }, futurePresentation: { texture: 'paper' } });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.document;
}

/** Real Action adapter, library and preview; only the Artifact storage is in memory. */
function actionBoundary() {
    const calls: { id: ThemeActionId; input: unknown }[] = [];
    const document = fixture();
    const harness = createThemeActionHarness();
    const action = createThemeActionExecute({ withLibrary: operation => operation(harness.library),
        readSelection: () => harness.selection, clientId: () => '', runtime: { preview: harness.owner,
            coverage: value => prepareThemeCss(value.profile.css ?? '').coverage,
            detailedCoverage: value => prepareThemeCss(value.profile.css ?? '').detailedCoverage(), surfaceMap: () => [] } });
    const execute: ThemeEditorExecute = async <Id extends ThemeActionId>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> => {
        const admitted = ThemeActionInputSchemas[id].parse(input);
        calls.push({ id, input: admitted });
        // The schema-admitted discriminant/input pair crosses the Action boundary.
        const result = await action({ actionId: id, input: admitted, context: { surface: 'ui' } } as ThemeActionRequest);
        return ThemeActionOutputSchemas[id].parse(result) as ThemeActionOutput<Id>;
    };
    return { calls, execute, document, ...harness };
}

describe('themeProfileEditorActions', () => {
    it('tries a retained edited document without saving, including the flushed CSS bytes', async () => {
        const { calls, execute, document, writes, owner } = actionBoundary();
        const editor = createThemeProfileEditorActions(execute);
        await editor.preview({ document, draft: { ...document.profile, name: 'Edited theme', style: { radius: 'round' } }, mode: 'light', css: '.composer { opacity: .8 }' });
        expect(calls.map(call => call.id)).toEqual([THEME_ACTION_IDS.tryOn]);
        expect(writes()).toBe(0);
        expect(owner.read()?.origin).toEqual({ kind: 'editor' });
        expect(calls[0]?.input).toMatchObject({ mode: 'light', origin: { kind: 'editor' }, document: { raw: {
            schemaVersion: 2, name: 'Edited theme', style: { radius: 'round', futureInset: 12 }, futurePresentation: { texture: 'paper' }, css: '.composer { opacity: .8 }',
        } } });
    });

    it('saves one existing addressed theme before keeping its shared try-on', async () => {
        const { calls, execute, document, rows, selection, writes, owner } = actionBoundary();
        rows.set(document.profile.id, { document, revision: 1, headerVersion: 1 });
        const editor = createThemeProfileEditorActions(execute);
        await editor.saveAndUse({ document, draft: { ...document.profile, name: 'Saved edit' }, mode: 'light', reference: { kind: 'artifact', id: document.profile.id } });
        expect(calls.map(call => call.id)).toEqual([THEME_ACTION_IDS.save, THEME_ACTION_IDS.tryOn, THEME_ACTION_IDS.keep]);
        expect(calls[0]?.input).toMatchObject({ ref: { kind: 'artifact', id: document.profile.id }, document: { raw: { name: 'Saved edit', futurePresentation: { texture: 'paper' } } } });
        expect(writes()).toBe(1);
        expect(selection.light).toEqual({ kind: 'artifact', id: document.profile.id });
        expect(selection.dark).toBeNull();
        expect(rows.get(document.profile.id)?.document.raw).toMatchObject({ name: 'Saved edit', schemaVersion: 2, futurePresentation: { texture: 'paper' } });
        expect(owner.read()).toBeNull();
    });

    it('keeps a new draft without a preliminary save', async () => {
        const { calls, execute, document, writes, rows } = actionBoundary();
        const editor = createThemeProfileEditorActions(execute);
        await editor.saveAndUse({ document, draft: document.profile, mode: 'light' });
        expect(calls.map(call => call.id)).toEqual([THEME_ACTION_IDS.tryOn, THEME_ACTION_IDS.keep]);
        expect(writes()).toBe(1);
        expect(rows.size).toBe(1);
    });
});
