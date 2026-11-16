import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';
import { prepareMachineSetupPreparationV1 } from './prepareMachineSetupPreparation';
import { googleChrome } from '../../../../../packages/plugins/machine-recipes/src/googleChrome';
import { tailscaleServer } from '../../../../../packages/plugins/machine-recipes/src/tailscaleServer';
import { dockerEngine } from '../../../../../packages/plugins/machine-recipes/src/dockerEngine';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

const recipe = MachineRecipeV1Schema.parse({ id: 'image-tools', revision: '1', title: 'Image tools',
    inputSchema: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'], additionalProperties: false },
    steps: [{ id: 'install', kind: 'command', executable: 'image-apply',
        args: [{ kind: 'input', path: 'tool' }, { kind: 'targetFact', fact: 'os.packageManager' }],
        check: { executable: 'image-check', args: [{ kind: 'input', path: 'tool' }], unsatisfiedExitCodes: [1] } }],
});
const selection = { ref: { pluginId: 'test.recipes', recipeId: recipe.id, revision: recipe.revision }, inputs: { tool: 'compiler' } };
const basis = { kind: 'preparation', operationId: 'image-build' };
const request = { v: 1, mode: 'apply', preparation: { basis, recipes: [{ recipe, selection }] } };

function fixture() {
    const installed = new Set<string>();
    const effects: string[][] = [];
    // Only the native process boundary is substituted. Expansion, prerequisite
    // observations, plan construction and the effect interpreter remain real.
    const runNative = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
        if (command.executable === 'apt-get') return { code: 0, stdout: 'apt 2.9.0', stderr: '' };
        if (command.executable === 'image-check') return { code: installed.has(command.args[0]!) ? 0 : 1, stdout: '', stderr: '' };
        if (command.executable === 'image-apply') {
            effects.push([...command.args]); installed.add(command.args[0]!);
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native process: ${command.executable}`);
    };
    const invoke = async (value: unknown, uid = 0) => {
        const stdin = new PassThrough(), stdout = new PassThrough();
        const chunks: string[] = [];
        stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
        stdin.end(JSON.stringify(value) + '\n');
        const code = await runMachineSetupEffectInternal(['--operation-id=image-build'], {
            stdin, stdout, runNative, readUid: () => uid, platform: 'linux', readNativeInit: async () => 'bash',
        });
        const text = chunks.join('');
        const records = text.trim().split('\n').map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line)));
        const last = records.at(-1);
        return { code, text, result: last?.type === 'result' ? last.result : undefined };
    };
    return { invoke, effects, installed };
}

describe('credential-free image setup through the existing root effect entry', () => {
    it('compiles recipe inputs against the actual image OS, then applies and verifies without a Machine or enrollment', async () => {
        const target = fixture();
        const produced = prepareMachineSetupPreparationV1({ operationId: basis.operationId,
            setup: { items: [{ kind: 'setupRecipe', selection }] },
            recipes: [{ pluginId: selection.ref.pluginId, definition: recipe }] });
        const response = await target.invoke({ v: 1, mode: 'apply', preparation: produced.preparation });
        expect(response.code).toBe(0);
        expect(response.result).toMatchObject({ status: 'applied', completedStepIds: ['install'], daemonRestartRequired: false });
        expect(target.effects).toEqual([['compiler', 'apt']]);
        expect((await target.invoke(request)).result).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(target.effects).toEqual([['compiler', 'apt']]);
    });

    it('bakes the public Chrome recipe prefix while leaving Tailscale credentials and every later dependency cold', () => {
        const chrome = MachineRecipeV1Schema.parse({ id: 'google-chrome', ...googleChrome });
        const tailscale = MachineRecipeV1Schema.parse({ id: 'tailscale-server', ...tailscaleServer });
        const chromeSelection = { ref: { pluginId: 'happier.machine.recipes', recipeId: chrome.id, revision: chrome.revision }, inputs: {} };
        const tailSelection = { ref: { ...chromeSelection.ref, recipeId: tailscale.id, revision: tailscale.revision },
            inputs: { distribution: 'debian-bookworm', joinCredential: {
                ref: formatSharedSavedSecretRefV1('private-network-key'), resourceRevision: 3 }, setOperator: false } };
        const setup: MachineSetupV1 = { items: [
            { kind: 'softwareRecipe', selection: chromeSelection },
            { kind: 'setupRecipe', selection: tailSelection },
            { kind: 'setupRecipe', selection },
        ], toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, scripts: [{ body: 'after recipes' }] };
        const produced = prepareMachineSetupPreparationV1({ operationId: basis.operationId, setup, recipes: [
            { pluginId: chromeSelection.ref.pluginId, definition: chrome },
            { pluginId: tailSelection.ref.pluginId, definition: tailscale },
            { pluginId: selection.ref.pluginId, definition: recipe },
        ] });
        expect(produced.bakedSetup).toEqual({ items: setup.items!.slice(0, 1) });
        expect(produced.deferredSetup).toEqual({ ...setup, items: setup.items!.slice(1) });
        expect(produced.preparation?.recipes.map(entry => entry.selection)).toEqual([chromeSelection]);
        expect(JSON.stringify(produced.preparation)).not.toMatch(/private-network-key|joinCredential|after recipes|\[tools\]/);
    });

    it('keeps native image prerequisites authoritative and does not pretend that an image has systemd', async () => {
        const target = fixture();
        const constrained = { ...recipe, steps: recipe.steps.map(step => ({ ...step,
            requiredFacts: [{ kind: 'init', system: 'systemd' }] })) };
        const response = await target.invoke({ ...request, preparation: { basis, recipes: [{ recipe: constrained, selection }] } });
        expect(response.result).toMatchObject({ status: 'unsupported' });
        expect(target.effects).toEqual([]);
    });

    it('defers the whole Docker recipe and ordered tail when it needs the enrolled daemon, without interpreting literal JSON as facts', () => {
        const chrome = MachineRecipeV1Schema.parse({ id: 'google-chrome', ...googleChrome });
        const docker = MachineRecipeV1Schema.parse({ id: DOCKER_ENGINE_RECIPE_REF_V1.recipeId, ...dockerEngine });
        const chromeSelection = { ref: { ...DOCKER_ENGINE_RECIPE_REF_V1, recipeId: chrome.id, revision: chrome.revision }, inputs: {} };
        const dockerSelection = { ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: 'group', daemonConfig: {} } };
        const setup: MachineSetupV1 = { items: [{ kind: 'softwareRecipe', selection: chromeSelection },
            { kind: 'softwareRecipe', selection: dockerSelection }, { kind: 'setupRecipe', selection }] };
        const produced = prepareMachineSetupPreparationV1({ operationId: basis.operationId, setup, recipes: [
            { pluginId: chromeSelection.ref.pluginId, definition: chrome },
            { pluginId: DOCKER_ENGINE_RECIPE_REF_V1.pluginId, definition: docker },
            { pluginId: selection.ref.pluginId, definition: recipe },
        ] });
        expect(produced.bakedSetup).toEqual({ items: setup.items!.slice(0, 1) });
        expect(produced.deferredSetup).toEqual({ items: setup.items!.slice(1) });
        expect(produced.preparation?.recipes.map(entry => entry.selection)).toEqual([chromeSelection]);

        const literal = MachineRecipeV1Schema.parse({ id: 'literal-json', revision: '1', title: 'Literal JSON',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'configuration', kind: 'file', path: '/etc/tool.json', owner: 'root', group: 'root', mode: 0o644,
                content: { kind: 'jsonMerge', value: { nested: { kind: 'targetFact', fact: 'daemon.username' } } } }] });
        const literalSelection = { ref: { ...selection.ref, recipeId: literal.id, revision: literal.revision }, inputs: {} };
        const literalSetup: MachineSetupV1 = { items: [{ kind: 'setupRecipe', selection: literalSelection }] };
        expect(prepareMachineSetupPreparationV1({ operationId: basis.operationId, setup: literalSetup,
            recipes: [{ pluginId: literalSelection.ref.pluginId, definition: literal }] }).bakedSetup).toEqual(literalSetup);
    });

    it('rejects credential-bearing or mismatched preparation operands and retains the root-only boundary', async () => {
        const target = fixture();
        const credentialRecipe = { ...recipe, steps: [{ id: 'credential', kind: 'file', path: '/private/key',
            lifetime: 'invocation', content: { kind: 'secretGrant', grantRef: 'private-grant' } }, ...recipe.steps] };
        for (const value of [
            { ...request, preparation: { basis, recipes: [{ recipe: credentialRecipe, selection }] } },
            { ...request, preparation: { basis: { ...basis, operationId: 'other-build' }, recipes: [{ recipe, selection }] } },
            { ...request, preparation: { basis, recipes: [{ recipe, selection: { ...selection,
                ref: { ...selection.ref, revision: 'other-revision' } } }] } },
            { ...request, installationId: 'fabricated', machineId: 'fabricated' },
        ]) expect((await target.invoke(value)).code).toBe(1);
        expect((await target.invoke(request, 1000)).result).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
        expect(target.effects).toEqual([]);
    });
});
