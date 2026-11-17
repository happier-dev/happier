import { describe, expect, it } from 'vitest';
import { THEME_ACTION_IDS, type ThemeActionInput } from '@happier-dev/protocol/actions/themeActionFamily';
import { createThemeActionHarness, themeActionDocument } from '@/dev/testkit/harness/themeActionHarness';
import { createShareThemePlugin } from '@/theme/profiles/shareThemePlugin';
import { createThemePluginShareForm } from './themePluginShareForm';

const labels = { share: 'Share as plugin', machine: 'Machine', path: 'Project path' };

describe('theme plugin share form', () => {
    it('requires an explicit Machine and path, then shares every selected reference on that Machine', async () => {
        const state = createThemeActionHarness();
        const refs = await Promise.all(['one', 'two'].map(async id =>
            (await state.library.save({ document: themeActionDocument(id) })).entry!.reference));
        const effects: { action: string; input: unknown }[] = [];
        const share = createShareThemePlugin(state.library);
        const form = createThemePluginShareForm({ refs, serverId: 'home', labels,
            execute: async (actionId, input) => {
                expect(actionId).toBe(THEME_ACTION_IDS.sharePlugin);
                const result = await share({ actionId, input, context: { hostReviewedChild: { invoke: async request => {
                    effects.push(request);
                    return request.action === 'plugins.scaffold'
                        ? { ok: true, result: { ok: true, createdPaths: { targetDir: '/chosen/project' } } }
                        : { ok: true, result: { ok: true, package: { archivePath: '/chosen/project.tgz', archiveDigest: 'digest' } } };
                } } } });
                if ('ok' in result) throw new Error(result.errorCode);
                return result;
            },
        });
        expect(form.getInput()).toEqual({});
        expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: false } });
        expect(effects).toEqual([]);
        form.replaceInput({ machine: { serverId: 'other-home', machineId: 'chosen-machine' }, path: '/chosen/project' });
        expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: false } });
        expect(effects).toEqual([]);
        form.replaceInput({ machine: { serverId: 'home', machineId: 'chosen-machine' }, path: '/chosen/project' });
        expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true,
            shared: { project: '/chosen/project', archive: '/chosen/project.tgz', digest: 'digest' } } });
        expect(effects).toMatchObject([
            { action: 'plugins.scaffold', input: { machineId: 'chosen-machine', targetDir: '/chosen/project', themes: [expect.anything(), expect.anything()] } },
            { action: 'plugins.pack', input: { machineId: 'chosen-machine', locator: '/chosen/project' } },
        ]);
        form.retire();
    });

    it('retains a failed draft for correction, and never dispatches after retirement', async () => {
        const state = createThemeActionHarness();
        const ref = (await state.library.save({ document: themeActionDocument('one') })).entry!.reference;
        const inputs: ThemeActionInput<typeof THEME_ACTION_IDS.sharePlugin>[] = [];
        const share = createShareThemePlugin(state.library);
        const form = createThemePluginShareForm({ refs: [ref], serverId: 'home', labels, execute: async (_id, input) => {
            inputs.push(input);
            const result = await share({ actionId: THEME_ACTION_IDS.sharePlugin, input,
                context: { hostReviewedChild: { invoke: async () => ({ ok: false,
                    errorCode: 'machine_unavailable', error: 'Machine unavailable' }) } } });
            if ('ok' in result) throw Object.assign(new Error(result.error), { errorCode: result.errorCode });
            return result;
        } });
        const draft = { machine: { serverId: 'home', machineId: 'offline' }, path: '/chosen/project' };
        form.replaceInput(draft);
        expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: false, code: 'machine_unavailable' } });
        expect(form.getInput()).toEqual(draft);
        form.retire();
        await form.submit();
        expect(inputs).toHaveLength(1);
    });
});
