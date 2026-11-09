import { describe, expect, it } from 'vitest';
import { machinePresetEditContinuationDraft, machinePresetEditDraftContent, machinePresetEditDraftUpdatePatch, type MachinePresetEditDraft } from './machinePresetEditDraft';

describe('Preset edit intent', () => {
    it('persists a pool target and clears the previous exact controller when saving the full draft', () => {
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1,
            name: 'Guest', choices: { cpu: 2 } };
        const pool = '6be84651-2df7-4125-aac4-0d093217b198';
        const content = machinePresetEditDraftContent({ name: 'Pooled guest', creation: { launch, controllerPoolId: pool } });
        expect(content).toMatchObject({ launch, controllerPoolId: pool });
        expect(content).not.toHaveProperty('controller');
        expect(machinePresetEditDraftUpdatePatch({ name: 'Pooled guest', creation: { launch, controllerPoolId: pool } }))
            .toMatchObject({ controllerPoolId: pool, controller: null });
        expect(machinePresetEditDraftUpdatePatch({ name: 'Exact guest', creation: { launch,
            controller: { machineId: 'host', installationId: 'installation' } } }))
            .toMatchObject({ controllerPoolId: null, controller: { machineId: 'host', installationId: 'installation' } });
    });
    it('authors a new non-catalog app key once in the draft and preserves legacy items without assigning keys', () => {
        const definition = { name: 'Dashboard', project: { kind: 'create' as const }, bindings: [],
            definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] } };
        const legacy = { kind: 'app' as const, definition: { ...definition, name: 'Legacy' } };
        const item = { kind: 'app' as const, definition };
        const draft: MachinePresetEditDraft = { name: 'Tools', setup: { items: [legacy] } };
        const result = machinePresetEditContinuationDraft({ draft, item, onReturn: () => undefined });
        expect(result).toMatchObject({ ok: true, draft: { setup: { items: [legacy, { ...item, authoredKey: expect.any(String) }] } } });
        if (!result.ok) throw new Error('Expected a new app draft');
        const content = machinePresetEditDraftContent(result.draft);
        expect(content.setup).toBe(result.draft.setup);
        expect(content.setup?.items?.[0]).not.toHaveProperty('authoredKey');
        expect(item).not.toHaveProperty('authoredKey');
        expect(draft.setup?.items).toEqual([legacy]);
    });
    it('resumes a setup-only continuation without restoring creation or mutating the caller draft', () => {
        const draft: MachinePresetEditDraft = { name: 'Build tools', creation: undefined,
            setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' }] } };
        const item = { kind: 'softwareRecipe' as const, selection: {
            ref: { pluginId: 'tools.example', recipeId: 'editor', revision: 'pinned-revision' }, inputs: { name: 'editor' },
        } };
        const result = machinePresetEditContinuationDraft({ draft, item, preset: { id: 'retained', revision: 8 },
            onReturn: () => { throw new Error('Entering the editor must not return'); } });
        expect(result).toEqual({ ok: true, draft: { ...draft, setup: { ...draft.setup, items: [item] } } });
        expect(draft.setup).not.toHaveProperty('items');
        if (!result.ok) throw new Error('Expected the continuation item to join the draft');
        expect(result.draft.creation).toBeUndefined();
        expect(result.draft.setup.scripts?.[0]).toBe(draft.setup?.scripts?.[0]);
    });

    it('removes the complete creation pair and delegated acquire without changing retained setup', () => {
        const setup = { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' as const }] };
        const patch = machinePresetEditDraftUpdatePatch({ name: 'Setup only', setup, creation: undefined });
        expect(patch).toEqual({ name: 'Setup only', setup, launch: null, controller: null, controllerPoolId: null,
            teamAcquireDelegated: false, retention: null, wakeOnAcceptedMessage: null, simultaneousLimit: null });
        expect(patch.setup).toBe(setup);
    });

    it('keeps name and exact setup independent of creation facts or receipts', () => {
        const setup = { scripts: [{ body: '\r\necho unchanged\r\n', affects: 'none' as const }, { body: '' }],
            toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"\n' } };
        const content = machinePresetEditDraftContent({ name: 'Build tools', setup });
        expect(content).toEqual({ name: 'Build tools', setup });
        expect(content.setup).toBe(setup);
        expect(content).not.toHaveProperty('launch');
        expect(content).not.toHaveProperty('controller');
        expect(content).not.toHaveProperty('reviewedFacts');
    });

    it('preserves complete creation and policy bytes, and treats explicit undefined as removal', () => {
        const creation = { launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1,
            name: 'Guest', choices: { cpu: 2 } }, controller: { machineId: 'controller', installationId: 'installation' },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false, simultaneousLimit: { maximum: 2 },
            id: 'retained-preset', homeId: 'home', name: 'Old name', setup: { scripts: [{ body: 'old setup' }] } };
        const draft: MachinePresetEditDraft = { name: 'Reusable guest', creation };
        const content = machinePresetEditDraftContent(draft);
        expect(content).toEqual({ name: draft.name, launch: creation.launch, controller: creation.controller,
            retention: creation.retention, wakeOnAcceptedMessage: false, simultaneousLimit: creation.simultaneousLimit });
        expect(content.launch).toBe(creation.launch);
        expect(content.controller).toBe(creation.controller);
        expect(content).not.toHaveProperty('id');
        expect(content).not.toHaveProperty('homeId');
        expect(content).not.toHaveProperty('setup');
        const setup = { scripts: [{ body: '' }] };
        expect(machinePresetEditDraftContent({ ...draft, creation: undefined, setup })).toEqual({ name: draft.name, setup });
        expect(machinePresetEditDraftContent({ ...draft, setup: undefined })).not.toHaveProperty('setup');
    });
});
