import { describe, expect, it } from 'vitest';
import { parseThemeProfileDocument, type ThemeProfileDocument, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionFamily';
import type { HostReviewedChildInvocationV1, HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';

import { createThemeProfileLibrary, type ThemeProfileArtifactAdapter } from './themeProfileLibrary';
import { createShareThemePlugin } from './shareThemePlugin';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';

function setup(count: number, packFails = false) {
    const documents = Array.from({ length: count }, (_, index) => {
        const parsed = parseThemeProfileDocument({
            schemaVersion: 1, id: `theme-${index}`, name: `Theme ${index}`,
            createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
            seeds: { canvas: '#121212', accent: '#aabbcc' },
            style: { radius: 'round', fontFamily: 'system' },
            css: '[data-surface="session"] {\n content: "quoted";\n}',
            futurePresentation: { ink: index },
        });
        if (!parsed.ok) throw new Error('Invalid fixture');
        return parsed.document;
    });
    const records = new Map<string, ThemeProfileDocument>(documents.map(document => [document.profile.id, document]));
    const reads: string[] = [];
    const writes: string[] = [];
    // Artifact persistence is the only substituted library boundary. All profile
    // parsing, reference resolution and share orchestration remain real.
    const artifacts: ThemeProfileArtifactAdapter = {
        load: async () => {}, list: () => [], getSummary: async () => null,
        get: async id => {
            reads.push(id);
            const document = records.get(id);
            return document ? { document, revision: 1, headerVersion: 1 } : null;
        },
        save: async () => { writes.push('save'); throw new Error('Share must not write Artifacts'); },
        delete: async () => { writes.push('delete'); throw new Error('Share must not delete Artifacts'); },
    };
    const library = createThemeProfileLibrary({ artifacts,
        readSelection: () => ({ light: null, dark: null }),
        writeSelection: () => { writes.push('selection'); },
        createId: () => { throw new Error('Share must not allocate a theme'); }, now: () => 0,
    });
    const calls: HostReviewedChildInvocationV1[] = [];
    const path = '/workspace/shared-themes';
    const child: HostReviewedChildPortV1 = {
        // The admitted Machine child transport is the other genuine boundary.
        invoke: async request => {
            calls.push(request);
            if (request.action === 'plugins.scaffold') return { ok: true, result: { ok: true, createdPaths: { targetDir: path } } };
            if (request.action === 'plugins.pack') return { ok: true, result: packFails
                ? { ok: false, diagnostics: [{ code: 'plugin_manifest_invalid', message: 'Cannot pack this project' }] }
                : { ok: true, package: { archivePath: `${path}.tgz`, archiveDigest: 'archive-digest' } } };
            throw new Error('Share must only scaffold and pack');
        },
    };
    const refs: ThemeReference[] = documents.map(document => ({ kind: 'artifact', id: document.profile.id }));
    return { share: createThemeActionExecute({ withLibrary: operation => operation(library),
        readSelection: () => ({ light: null, dark: null }), clientId: () => '' }), documents, reads, writes, calls, path,
        request: ({ actionId: THEME_ACTION_IDS.sharePlugin, input: { refs, machineId: 'machine-one', path }, context: { hostReviewedChild: child } } satisfies
            Parameters<ReturnType<typeof createShareThemePlugin>>[0]) };
}

describe('share themes as a plugin', () => {
    it.each([1, 40])('shares %i selected themes with one scaffold and one pack, preserving retained data', async count => {
        const state = setup(count);
        await expect(state.share(state.request)).resolves.toEqual({ project: state.path, archive: `${state.path}.tgz`, digest: 'archive-digest' });
        expect(state.calls).toEqual([
            { action: 'plugins.scaffold', role: 'theme.share.scaffold', input: {
                targetDir: state.path, machineId: 'machine-one', template: 'themes', id: 'local.shared-themes',
                name: 'Shared themes', themes: state.documents.map(document => document.raw),
            } },
            { action: 'plugins.pack', role: 'theme.share.pack', input: { locator: state.path, machineId: 'machine-one' } },
        ]);
        expect(state.reads).toEqual(state.documents.map(document => document.profile.id));
        expect(state.writes).toEqual([]);
    });

    it('returns the pack diagnostic and created project for retry without further effects', async () => {
        const state = setup(1, true);
        await expect(state.share(state.request)).resolves.toMatchObject({ ok: false, errorCode: 'plugin_manifest_invalid',
            details: { phase: 'pack', project: state.path, diagnostics: [{ code: 'plugin_manifest_invalid' }] } });
        expect(state.calls.map(call => call.action)).toEqual(['plugins.scaffold', 'plugins.pack']);
        expect(state.writes).toEqual([]);
    });
});
