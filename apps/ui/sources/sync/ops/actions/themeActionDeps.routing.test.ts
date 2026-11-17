import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { createThemeProfileLibrary, type ThemeProfileArtifactAdapter } from '@/theme/profiles/themeProfileLibrary';
import { createThemeActionExecute, type ThemeActionHost } from './themeActionDeps';
import { executeDesktopAppWindowClientAction } from './desktopAppWindowActionDispatch';

function fixture() {
    let selectionWrites = 0;
    let libraryLoads = 0;
    const artifacts: ThemeProfileArtifactAdapter = {
        load: async () => { libraryLoads++; }, list: () => [], get: async () => null, getSummary: async () => null,
        save: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => {},
    };
    const library = createThemeProfileLibrary({ artifacts, readSelection: () => ({ light: null, dark: null }),
        writeSelection: () => { selectionWrites++; }, createId: () => 'undo-id', now: () => 0 });
    const sent: unknown[] = [];
    const host = {
        readSelection: () => ({ light: null, dark: null }),
        withLibrary: async operation => operation(library), clientId: () => 'this-app',
        dispatchClientAction: async request => {
            sent.push(request);
            return { themes: [], devices: [{ id: 'this-app', deviceLabel: null }, { id: 'other-app', deviceLabel: 'Phone' }] };
        },
    } satisfies ThemeActionHost;
    const execute = createThemeActionExecute(host);
    const admitted = createActionExecutor({ themeAction: execute,
        clientActionExecute: request => executeDesktopAppWindowClientAction(request, {}, {
            clientId: host.clientId,
            // The app transport is the process/network boundary; local delivery remains real.
            dispatch: async (request, clientId) => {
                sent.push(request);
                return { ok: true, result: { applied: { clientId, mode: 'dark' }, undoHandle: 'remote-undo' } };
            },
        }),
    });
    return { execute, admitted, sent, loads: () => libraryLoads, writes: () => selectionWrites };
}
const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
describe('theme app client routing', () => {
    it('returns connected candidates for app discovery without a second local library read', async () => {
        const f = fixture();
        expect(await f.execute({ actionId: THEME_ACTION_IDS.list, input: { includeDevices: true }, context }))
            .toMatchObject({ devices: [{ id: 'this-app', deviceLabel: null }, { id: 'other-app', deviceLabel: 'Phone' }] });
        expect(f.sent).toHaveLength(1);
        expect(f.loads()).toBe(0);
        expect(f.writes()).toBe(0);
    });
    it('targets another app without mutating this device, while an exact self target stays local', async () => {
        const f = fixture();
        expect(await f.admitted.execute(THEME_ACTION_IDS.apply, { ref: null, mode: 'dark', clientId: 'other-app' }, context))
            .toEqual({ ok: true, result: { applied: { clientId: 'other-app', mode: 'dark' }, undoHandle: 'remote-undo' } });
        expect(f.sent).toHaveLength(1);
        expect(f.loads()).toBe(0);
        expect(f.writes()).toBe(0);
        expect(await f.admitted.execute(THEME_ACTION_IDS.apply, {
            ref: { kind: 'built-in', presetId: 'classicDark' }, mode: 'dark', clientId: 'this-app',
        }, context)).toMatchObject({ ok: true, result: { applied: { clientId: 'this-app', mode: 'dark' }, undoHandle: expect.any(String) } });
        expect(f.sent).toHaveLength(1);
        expect(f.writes()).toBe(1);
    });
});
