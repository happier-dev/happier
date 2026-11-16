import { PassThrough } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import axios from '@/api/client/credentialAxios';
import { AccountSettingsSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';
import { runBoundSessionSetup } from './boundSessionSetup';

const machine = ManagedMachineFullV1Schema.parse({ id: 'bound-target', homeId: 'home', custodianAccountId: 'owner',
        controller: { machineId: 'controller', installationId: 'installation' },
        preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Target', choices: {} },
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, acquisitionMode: 'resource-bound',
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });

it('checks and applies recipes in the bound guest interpreter, retries unsatisfied effects and refuses unprepared apps', async () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'tool', revision: '1', title: 'Guest tool',
        inputSchema: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'], additionalProperties: false },
        steps: [{ id: 'install', kind: 'command', executable: 'guest-install', args: [{ kind: 'input', path: 'tool' }],
            check: { executable: 'guest-check', args: [{ kind: 'input', path: 'tool' }], unsatisfiedExitCodes: [1] } }] });
    const recipes = ['first', 'second'].map(id => ({ ...recipe, id }));
    const setup = { items: recipes.map(recipe => ({ kind: 'setupRecipe' as const,
        selection: { ref: { pluginId: 'guest.tools', recipeId: recipe.id, revision: recipe.revision }, inputs: { tool: recipe.id } } })) };
    const installed = new Set<string>(), effects: string[] = [], modes: string[] = [], states: string[] = [];
    let failSecond = true, abortAfterFirst = false;
    const controller = new AbortController(), signal = controller.signal;
    const input: Parameters<typeof runBoundSessionSetup>[0] = { machine, setup, sessionId: 'committed-session', requesterAccountId: 'owner',
        binaryPath: '/guest/prepared/happier', platform: { os: 'linux', arch: 'x64', home: '/guest/home' },
        recipes: recipes.map(definition => ({ pluginId: 'guest.tools', definition })), signal,
        operation: { actionRequestId: 'session-operation', signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        report: async state => { states.push(state); },
        transport: { putFile: async () => { throw new Error('Recipe filesystem effects belong in the guest interpreter'); }, exec: async request => {
            expect(request.command).toContain("'/guest/prepared/happier'");
            expect(request.command).not.toContain('--installation-id');
            expect(request.input).toContain('committed-session');
            expect(request.input).not.toContain('admittedInputDigest');
            modes.push((JSON.parse(request.input!) as { mode: string }).mode);
            const stdin = new PassThrough(), stdout = new PassThrough();
            let output = '';
            stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); request.onStdoutChunk?.(chunk.toString()); });
            stdin.end(request.input);
            const status = await runMachineSetupEffectInternal(['--operation-id=session-operation'], { stdin, stdout, signal: request.signal,
                readUid: () => 0, platform: 'linux', runNative: async command => {
                    const tool = command.args[0]!;
                    if (command.executable === 'guest-check') return { code: installed.has(tool) ? 0 : 1, stdout: '', stderr: '' };
                    if (command.executable !== 'guest-install') throw new Error('Unexpected guest command');
                    effects.push(tool);
                    if (tool === 'second' && failSecond) return { code: 19, stdout: '', stderr: '' };
                    installed.add(tool);
                    if (abortAfterFirst) controller.abort();
                    return { code: 0, stdout: '', stderr: '' };
                } });
            return { status, stdout: output, stderr: '' };
        } } };
    await expect(runBoundSessionSetup(input)).rejects.toMatchObject({ code: 'native_effect_failed' });
    expect(installed).toEqual(new Set(['first']));
    failSecond = false;
    await runBoundSessionSetup(input);
    expect(installed).toEqual(new Set(['first', 'second']));
    expect(effects).toEqual(['first', 'second', 'second']);
    expect(modes).toEqual(['check', 'apply', 'check', 'apply']);
    expect(states).toEqual(['running', 'failed', 'running', 'succeeded']);
    const modesBeforeApp = [...modes];
    await expect(runBoundSessionSetup({ ...input, setup: { items: [{ kind: 'app', definition: {
        name: 'Guest app', project: { kind: 'existing', projectSourceId: 'project' },
        definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] }, bindings: [],
    } }] } })).rejects.toMatchObject({ code: 'machine_setup_app_preparation_unavailable' });
    expect(modes).toEqual(modesBeforeApp);
    installed.clear();
    effects.length = 0;
    abortAfterFirst = true;
    await expect(runBoundSessionSetup(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(effects).toEqual(['first']);
    expect(states.at(-1)).toBe('running');
});

it.skipIf(process.platform === 'win32')('materializes selected requester secrets only into the admitted guest script environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bound-secret-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const token = 'requester-account-token', resourceId = 'setup-secret';
    const ref = `happier:shared-secret:v1:${resourceId}`;
    const context = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
        snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) },
        serverHttpBaseUrl: 'https://requester-home.example', isCurrent: async () => true });
    onTestFinished(() => context.withdrawCatalog());
    const material = { resourceId, encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Script key', kind: 'token',
            ownerAccountId: 'requester', revision: 3, materialStatus: 'ready',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Script key', kind: 'token', value: 'ephemeral-guest-value' } }) };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
        expect(String(url)).toBe('https://requester-home.example/v1/account/saved-secrets/resources/materials');
        return { status: 200, data: { resources: [material] } };
    });
    onTestFinished(() => get.mockRestore());
    const reports: unknown[] = [], commands: string[] = [], inputs: string[] = [];
    const signal = new AbortController().signal;
    const input = { machine, sessionId: 'committed-session', requesterAccountId: 'requester',
        setup: { scripts: [{ body: 'test "$SETUP_KEY" = ephemeral-guest-value' }],
            secretRefs: { v: 1 as const, bindings: { SETUP_KEY: { ref, revision: 3 } } } },
        binaryPath: '/guest/happier', platform: { os: 'linux' as const, arch: 'x64' as const, home }, recipes: [], signal,
        savedSecrets: { credentials: context.credentials, serverHttpBaseUrl: context.serverHttpBaseUrl, operationContext: context },
        operation: { actionRequestId: 'secret-setup', signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        report: async (...args: unknown[]) => { reports.push(args); },
        transport: { putFile: async () => { throw new Error('No guest configuration'); }, exec: async (request: { command: string; input?: string; signal?: AbortSignal }) => {
            commands.push(request.command);
            inputs.push(request.input ?? '');
            const child = promisify(execFile)('/bin/sh', ['-c', request.command], { signal: request.signal, env: { HOME: home } });
            child.child.stdin?.on('error', () => {});
            child.child.stdin?.end(request.input);
            const result = await child;
            return { status: 0, stdout: result.stdout, stderr: result.stderr };
        } },
    };
    await expect(runBoundSessionSetup(input)).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('ephemeral-guest-value');
    expect(inputs[0]).toContain('ephemeral-guest-value');
    expect(JSON.stringify(reports)).not.toContain('ephemeral-guest-value');
    expect(reports.at(-1)).toEqual(['succeeded', expect.any(Object), undefined]);
});

it('retains an unconfirmed guest process outcome instead of reporting failed Setup', async () => {
    const signal = new AbortController().signal, states: string[] = [];
    await expect(runBoundSessionSetup({ machine, sessionId: 'committed-session', requesterAccountId: 'owner',
        setup: { scripts: [{ body: 'apply-later', check: { executable: 'guest-check', args: [], unsatisfiedExitCodes: [1] } }] },
        binaryPath: '/guest/happier', platform: { os: 'linux', arch: 'x64', home: '/guest/home' }, recipes: [], signal,
        operation: { actionRequestId: 'uncertain-operation', signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
        report: async state => { states.push(state); }, transport: {
            exec: async () => { throw Object.assign(new Error('Native process settlement not observed'), { code: 'plugin_exec_termination_incomplete' }); },
            putFile: async () => { throw new Error('No configuration'); },
        },
    })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
    expect(states).toEqual(['running']);
});
