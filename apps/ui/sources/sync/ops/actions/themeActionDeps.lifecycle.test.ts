import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { createThemeActionHarness as setup, themeActionDocument as document } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from './themeActionDeps';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { prepareThemeCss } from '@/theme/css/prepareThemeCss';


const actionContext = { surface: 'ui' as const, authority: 'present_user' as const };
describe('theme Actions through real library and try-on owners', () => {
    it('rejects a Store preview without its listing before creating the overlay', async () => {
        const f = setup();
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => '',
            runtime: { preview: f.owner,
                coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
                detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
                surfaceMap: () => [] },
        }) });
        const result = await execute.execute(THEME_ACTION_IDS.tryOn,
            { document: document('store-without-listing'), mode: 'dark', origin: { kind: 'store' } }, actionContext);
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
        expect(f.owner.read()).toBeNull();
        expect(f.writes()).toBe(0);
    });
    it('imports and exports retained presentation fields, then undoes apply without deleting a saved theme', async () => {
        const f = setup();
        const execute = createThemeActionExecute({ withLibrary: async operation => operation(f.library),
            readSelection: () => f.selection, clientId: () => '' });
        const imported = await execute({ actionId: THEME_ACTION_IDS.import,
            input: { file: { name: 'theme.json', text: exportThemeProfileToJson(document('retained')) } }, context: actionContext });
        expect(imported).toHaveProperty('entry');
        if (!('entry' in imported)) throw new Error('Import failed');
        const exported = await execute({ actionId: THEME_ACTION_IDS.export, input: { ref: imported.entry.reference }, context: actionContext });
        expect(exported).toHaveProperty('file');
        if (!('file' in exported)) throw new Error('Export failed');
        expect(exported.file.text).toContain('futurePresentation');
        const applied = await execute({ actionId: THEME_ACTION_IDS.apply, input: { ref: imported.entry.reference, mode: 'dark' }, context: actionContext });
        if (!('undoHandle' in applied)) throw new Error('Apply failed');
        expect(await execute({ actionId: THEME_ACTION_IDS.undo, input: { undoHandle: applied.undoHandle }, context: actionContext }))
            .toMatchObject({ restored: { dark: null } });
        expect(f.rows.size).toBe(1);
        expect(f.selection.dark).toBeNull();
    });
    it('tries without writes, keeps only the current proposal, and refuses stale previews', async () => {
        const f = setup();
        const execute = createThemeActionExecute({
            withLibrary: async operation => operation(f.library),
            readSelection: () => f.selection,
            clientId: () => '',
            runtime: { preview: f.owner,
            coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
            detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
            surfaceMap: () => [] },
        });
        const first = await execute({ actionId: THEME_ACTION_IDS.tryOn, input: { document: document('first'), mode: 'dark', origin: { kind: 'agent' } }, context: actionContext });
        expect(first).toHaveProperty('previewRef');
        if (!('previewRef' in first)) throw new Error('Try-on failed');
        const second = await execute({ actionId: THEME_ACTION_IDS.tryOn, input: { document: document('second'), mode: 'dark', origin: { kind: 'agent' } }, context: actionContext });
        if (!('previewRef' in second)) throw new Error('Try-on failed');
        expect(f.writes()).toBe(0);
        await expect(execute({ actionId: THEME_ACTION_IDS.revert, input: { previewRef: first.previewRef }, context: actionContext }))
            .rejects.toMatchObject({ code: 'theme_preview_stale' });
        const kept = await execute({ actionId: THEME_ACTION_IDS.keep, input: { previewRef: second.previewRef }, context: actionContext });
        expect(kept).toHaveProperty('undoHandle');
        if (!('undoHandle' in kept)) throw new Error('Keep failed');
        expect(f.writes()).toBe(1);
        expect(f.rows.size).toBe(1);
        await execute({ actionId: THEME_ACTION_IDS.undo, input: { undoHandle: kept.undoHandle }, context: actionContext });
        expect(f.rows.size).toBe(0);
        expect(f.selection.dark).toBeNull();
    });
});
