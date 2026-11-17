import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { mergeThemeProfileDocumentEdit } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createThemeActionHarness as setup, themeActionDocument as document } from '@/dev/testkit/harness/themeActionHarness';
import { createThemeActionExecute } from './themeActionDeps';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { prepareThemeCss } from '@/theme/css/prepareThemeCss';
import { createThemeProfileSourceAdapter } from '@/theme/profiles/themeProfileLibrary';

// Platform is the external paint adapter; all profile and material owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const actionContext = { surface: 'ui' as const, authority: 'present_user' as const };
describe('theme Actions through real library and try-on owners', () => {
    it('lists a paired theme for either requested mode without duplicating the unfiltered library', async () => {
        const f = setup();
        const paired = mergeThemeProfileDocumentEdit(document('paired'), { assetAppearance: 'light', overrides: {
            light: { 'background.canvas': '#fefefe' }, dark: { 'background.canvas': '#101010' },
        } });
        const saved = (await f.library.save({ document: paired })).entry!;
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(f.library), readSelection: () => f.selection, clientId: () => '',
        }) });
        for (const mode of [undefined, 'light', 'dark'] as const) {
            const listed = await execute.execute(THEME_ACTION_IDS.list, { mode }, actionContext);
            expect(listed).toMatchObject({ ok: true });
            if (!listed.ok || !listed.result || typeof listed.result !== 'object' || !('themes' in listed.result)
                || !Array.isArray(listed.result.themes)) throw new Error('Expected theme list');
            expect(listed.result.themes.filter(entry => entry.id === saved.id)).toHaveLength(1);
        }
    });

    it('tries base and existing themes without saving copies, then keeps their mode slot', async () => {
        const f = setup();
        const saved = (await f.library.save({ document: document('existing') })).entry!;
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(f.library), readSelection: () => f.selection, clientId: () => '',
            runtime: { preview: f.owner, coverage: value => prepareThemeCss(value.profile.css ?? '').coverage,
                detailedCoverage: value => prepareThemeCss(value.profile.css ?? '').detailedCoverage },
        }) });
        const before = f.writes();
        for (const value of [await f.library.get(saved.reference), null]) {
            const tried = await execute.execute(THEME_ACTION_IDS.tryOn, { document: value, mode: 'dark', origin: { kind: 'editor' } }, actionContext);
            expect(tried).toMatchObject({ ok: true });
            expect(f.writes()).toBe(before);
            expect(f.owner.read()?.mode).toBe('dark');
            const kept = await execute.execute(THEME_ACTION_IDS.keep, { previewRef: f.owner.read()!.previewRef }, actionContext);
            expect(kept).toMatchObject({ ok: true });
            expect(f.selection.dark).toEqual(value ? saved.reference : null);
            expect(f.writes()).toBe(before);
        }
    });

    it('keeps a tried plugin theme as its admitted reference without copying it into Artifacts', async () => {
        const { createThemeProfileLibrary } = await import('@/theme/profiles/themeProfileLibrary');
        const { projectThemeLibraryEntry } = await import('@/theme/profiles/themeProfilePresentation');
        const { createThemeTryOnOwner } = await import('@/theme/profiles/themeTryOn');
        const f = setup();
        const reference = { kind: 'plugin', pluginId: 'sample.palette', contributionId: 'night' } as const;
        const plugin = mergeThemeProfileDocumentEdit(document('night'), { source: reference });
        const library = createThemeProfileLibrary({ ...f.context,
            pluginProfiles: { list: () => [projectThemeLibraryEntry(plugin)], get: async () => plugin } });
        const owner = createThemeTryOnOwner({ captureScope: () => ({ serverId: 'home', accountId: 'account' }),
            select: input => library.select(input), keep: input => library.keep(input),
            installStore: async () => { throw new Error('Plugin themes do not use registry installation'); } });
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(library), readSelection: () => f.selection, clientId: () => 'this-app',
            runtime: { preview: owner, coverage: value => prepareThemeCss(value.profile.css ?? '').coverage,
                detailedCoverage: value => prepareThemeCss(value.profile.css ?? '').detailedCoverage },
        }) });
        expect(await execute.execute(THEME_ACTION_IDS.apply, { ref: null, mode: 'dark' }, actionContext)).toMatchObject({ ok: true });
        expect(await execute.execute(THEME_ACTION_IDS.tryOn, { document: plugin, mode: 'dark', origin: { kind: 'store' } }, actionContext))
            .toMatchObject({ ok: true });
        expect(owner.read()?.origin).toEqual({ kind: 'store', reference });
        expect(f.writes()).toBe(0);
        expect(owner.read()?.selection).toEqual(reference);
        expect(await execute.execute(THEME_ACTION_IDS.keep, { previewRef: owner.read()!.previewRef }, actionContext)).toMatchObject({ ok: true });
        expect(f.selection.dark).toEqual(reference);
        expect(f.writes()).toBe(0);
        expect(await execute.execute(THEME_ACTION_IDS.tryOn, { document: mergeThemeProfileDocumentEdit(plugin, { name: 'Edited plugin' }),
            mode: 'dark', origin: { kind: 'store' } }, actionContext)).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
        expect(owner.read()).toBeNull();
    });
    it('preserves immutable-source refusals for installed Artifact saves and deletes through the Action receiver', async () => {
        const f = setup();
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => 'this-app',
        }) });
        expect(await execute.execute(THEME_ACTION_IDS.save, { document: document('editable-control') }, actionContext))
            .toMatchObject({ ok: true, result: { entry: { source: { kind: 'yours' } } } });
        const source = createThemeProfileSourceAdapter(f.context);
        const installed = await source.save(mergeThemeProfileDocumentEdit(document('installed'), { source: {
            kind: 'store', contributionId: 'dark', provenance: { sourceId: 'registry', format: 'git',
                sourceUrl: 'https://registry.example.test', itemId: 'package',
                ref: { kind: 'gitTree', repo: 'https://registry.example.test/themes.git', path: 'theme', commit: 'first', treeSha: 'first-tree' }, importedAt: 0 },
        } }));
        if (!installed.entry) throw new Error('Expected installed fixture');
        const retained = await f.library.get(installed.entry.reference);
        if (!retained) throw new Error('Expected installed document');
        const writes = f.writes();
        for (const inputDocument of [retained, mergeThemeProfileDocumentEdit(retained, { source: { kind: 'yours' } })]) {
            expect(await execute.execute(THEME_ACTION_IDS.save,
                { ref: installed.entry.reference, document: inputDocument }, actionContext))
                .toMatchObject({ ok: false, errorCode: 'theme_immutable_source' });
        }
        expect(await execute.execute(THEME_ACTION_IDS.delete, { ref: installed.entry.reference }, actionContext))
            .toMatchObject({ ok: false, errorCode: 'theme_immutable_source' });
        expect(f.writes()).toBe(writes);
        expect(await f.library.get(installed.entry.reference)).toEqual(retained);
    });
    it('returns a built-in document through the public Action output parser', async () => {
        const f = setup();
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => 'this-app',
        }) });
        expect(await execute.execute(THEME_ACTION_IDS.get,
            { ref: { kind: 'built-in', presetId: 'premiumDark' }, include: ['document'] }, actionContext))
            .toMatchObject({ ok: true, result: { document: { profile: { source: { kind: 'built-in' } } } } });
    });
    it('projects the requested retained profile and mode into its surface map and guide', async () => {
        const { projectThemeSurfacePaintMap } = await import('@/theme/css/themeSurfacePaintMap');
        const f = setup();
        const base = mergeThemeProfileDocumentEdit(document('requested-paint'), { overrides: {
            light: { 'message.user.background': '#123456' }, dark: { 'message.user.background': '#123456' },
        } });
        const requested = mergeThemeProfileDocumentEdit(base, { assetAppearance: 'dark',
            overrides: { light: base.profile.overrides.light, dark: { 'message.user.background': 'rgba(30, 40, 50, 0.3)' } } });
        const saved = await f.library.save({ document: requested });
        if (!saved.entry) throw new Error('Expected saved fixture');
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => 'this-app',
            runtime: { preview: f.owner,
                coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
                detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
                surfaceMap: projectThemeSurfacePaintMap },
        }) });
        const expected = projectThemeSurfacePaintMap(requested, 'dark');
        const bubbleBackground = (map: typeof expected) => map.find(row => row.address.surface === 'user-bubble'
            && row.address.part === 'root' && row.address.state === undefined)?.paintRoles.find(role => role.facet === 'background');
        expect(bubbleBackground(expected)).toEqual({ facet: 'background', source: { kind: 'token', ref: 'message.user.background' } });
        expect(bubbleBackground(projectThemeSurfacePaintMap(base, 'dark'))).not.toEqual(bubbleBackground(expected));
        expect(bubbleBackground(projectThemeSurfacePaintMap(requested, 'light'))).not.toEqual(bubbleBackground(expected));
        const result = await execute.execute(THEME_ACTION_IDS.get,
            { ref: saved.entry.reference, include: ['surfaceMap', 'guide'] }, actionContext);
        expect(result).toMatchObject({ ok: true, result: { surfaceMap: expected } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null
            || !('guide' in result.result) || typeof result.result.guide !== 'string') throw new Error('Expected guide');
        expect(JSON.parse(result.result.guide.split('\n').at(-1)!)).toMatchObject({ surfaceMap: expected });
    });

    it.each(['absent', 'empty'] as const)('refuses an %s surface map instead of returning a successful empty guide', async state => {
        const f = setup();
        const saved = await f.library.save({ document: document('surface-map-request') });
        if (!saved.entry) throw new Error('Expected saved fixture');
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => 'this-app',
            runtime: { preview: f.owner,
                coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
                detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
                ...(state === 'empty' ? { surfaceMap: () => [] } : {}) },
        }) });
        expect(await execute.execute(THEME_ACTION_IDS.get,
            { ref: saved.entry.reference, include: ['surfaceMap', 'guide'] }, actionContext))
            .toMatchObject({ ok: false, errorCode: 'client_not_connected' });
    });

    it('returns consumable Undo for repeated apply and Keep, preserving typed missing and expired failures', async () => {
        const f = setup();
        const execute = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: async operation => operation(f.library), readSelection: () => f.selection, clientId: () => 'this-app',
            runtime: { preview: f.owner,
                coverage: document => prepareThemeCss(document.profile.css ?? '').coverage,
                detailedCoverage: document => prepareThemeCss(document.profile.css ?? '').detailedCoverage,
                surfaceMap: () => [] },
        }) });
        const applied = await execute.execute(THEME_ACTION_IDS.apply, { ref: null, mode: 'dark' }, actionContext);
        expect(applied).toMatchObject({ ok: true, result: { undoHandle: expect.any(String) } });
        if (!applied.ok || typeof applied.result !== 'object' || !applied.result || !('undoHandle' in applied.result)) {
            throw new Error('Expected successful apply');
        }
        expect(await execute.execute(THEME_ACTION_IDS.undo, { undoHandle: applied.result.undoHandle }, actionContext))
            .toMatchObject({ ok: true, result: { restored: { dark: null } } });
        expect(await execute.execute(THEME_ACTION_IDS.undo, { undoHandle: applied.result.undoHandle }, actionContext))
            .toMatchObject({ ok: false, errorCode: 'theme_undo_handle_unknown' });

        const saved = await f.library.save({ document: document('already-saved') });
        if (!saved.entry) throw new Error('Expected saved fixture');
        await f.library.select({ reference: saved.entry.reference, mode: 'dark' });
        const retained = await f.library.get(saved.entry.reference);
        if (!retained) throw new Error('Expected retained fixture');
        const preview = f.owner.begin({ document: retained, mode: 'dark', origin: { kind: 'agent' } });
        const kept = await execute.execute(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef }, actionContext);
        expect(kept).toMatchObject({ ok: true, result: { undoHandle: expect.any(String) } });
        if (!kept.ok || typeof kept.result !== 'object' || !kept.result || !('undoHandle' in kept.result)) {
            throw new Error('Expected successful Keep');
        }
        expect(await execute.execute(THEME_ACTION_IDS.undo, { undoHandle: kept.result.undoHandle }, actionContext))
            .toMatchObject({ ok: true, result: { restored: { dark: saved.entry.reference } } });
        expect(f.rows.size).toBe(1);
        expect(f.writes()).toBe(1);
        expect(await execute.execute(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef }, actionContext))
            .toMatchObject({ ok: false, errorCode: 'theme_preview_stale' });
        for (const actionId of [THEME_ACTION_IDS.apply, THEME_ACTION_IDS.duplicate]) {
            expect(await execute.execute(actionId, { ref: { kind: 'artifact', id: 'missing' },
                ...(actionId === THEME_ACTION_IDS.apply ? { mode: 'dark' } : {}) }, actionContext))
                .toMatchObject({ ok: false, errorCode: 'theme_not_found' });
        }
    });
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
        if (!('undoHandle' in applied) || typeof applied.undoHandle !== 'string') throw new Error('Apply failed');
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
        if (!('undoHandle' in kept) || typeof kept.undoHandle !== 'string') throw new Error('Keep failed');
        expect(f.writes()).toBe(1);
        expect(f.rows.size).toBe(1);
        await execute({ actionId: THEME_ACTION_IDS.undo, input: { undoHandle: kept.undoHandle }, context: actionContext });
        expect(f.rows.size).toBe(0);
        expect(f.selection.dark).toBeNull();
    });
});
