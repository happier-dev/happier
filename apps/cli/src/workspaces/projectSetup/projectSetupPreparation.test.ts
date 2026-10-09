import axios from 'axios';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
// Load the real child reader's lazy API graph before behavior timers; HTTP remains at the genuine boundary below.
import '@/api/api';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { mkdtemp, mkdir, rm, writeFile, access, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { resolveProjectNativeAdapter } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { createScmBackendRegistry } from '@/scm/registry';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/scm/contracts/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { pixiAdapter, pixiPlugin, pixiRuntime, importedPixiEnvironment } from '../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source';

import { createProjectSetupSuccessStore } from './projectSetupSuccess';
import { prepareProjectSetup, reviewProjectSetupEffect, type ProjectSetupPreparationInput } from './projectSetupPreparation';
import { projectNativeSystemIo } from './projectNativeSystemIo';

describe('current Project setup effect and preparation admission', () => {
    const roots: string[] = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });
    async function fixture(manifest: unknown, files: Readonly<Record<string, string | Buffer>> = {}) {
        const root = await mkdtemp(join(tmpdir(), 'happier-project-setup-'));
        roots.push(root);
        await mkdir(join(root, '.happier'));
        await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest));
        for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
        const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine-a', rootPath: root, projectKey: 'project-p', createdAtMs: 1 };
        const input: ProjectSetupPreparationInput = {
            workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project-p' } },
            requester: { credentials: { token: 'approving-user', encryption: null }, serverHttpBaseUrl: 'https://requester.example' },
            purpose: 'setup', platform: { os: 'linux', arch: 'x64' },
            nativeIo: { resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) },
        };
        return { root, input };
    }
    function trustTransport(digest: string | null) {
        vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
            expect(url).toBe('https://requester.example/v1/account/encryption');
            expect(options?.headers?.Authorization).toBe('Bearer approving-user');
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        return vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            expect(url).toBe('https://requester.example/v1/account/project-trust/read');
            expect(options?.headers?.Authorization).toBe('Bearer approving-user');
            expect(body).toEqual({ project: { serverId: 'home', projectId: 'project-p' } });
            return { status: 200, data: digest === null ? { status: 'absent' } : {
                status: 'present', revision: 1, content: { t: 'plain', v: {
                    project: { serverId: 'home', projectId: 'project-p' }, reviewedEffectDigest: digest, approvedAtMs: 1,
                } },
            } };
        });
    }
    async function reviewed(input: ProjectSetupPreparationInput) {
        const result = await reviewProjectSetupEffect(input);
        expect(result).toMatchObject({ kind: 'reviewed' });
        if (result.kind !== 'reviewed') throw new Error(result.code);
        return result.plan;
    }

    it.skipIf(process.platform === 'win32')('reviews installed package-manager identity without binding cross-Machine trust to runtime prefix paths or host PATH', async () => {
        const manifest = { version: 1, workspace: { setup: [{ kind: 'native', tool: 'package_script', file: 'package.json', target: 'setup' }] } };
        const files = { 'package.json': JSON.stringify({ packageManager: 'npm@4.6.0', scripts: { setup: 'echo prepared' } }) };
        const a = await fixture(manifest, files);
        const b = await fixture(manifest, files);
        async function installed(input: ProjectSetupPreparationInput) {
            const root = await mkdtemp(join(tmpdir(), 'happier-setup-installed-'));
            roots.push(root);
            const directory = join(root, 'installed-npm');
            await mkdir(join(directory, 'bin'), { recursive: true });
            const script = join(directory, 'bin', 'npm.cjs');
            await writeFile(script, '#!/usr/bin/env node\nthrow new Error("review must not execute npm");\n');
            await chmod(script, 0o755);
            await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'npm', version: '4.6.0', bin: { npm: 'bin/npm.cjs' } }));
            await symlink(script, join(root, 'npm'));
            vi.stubEnv('PATH', root);
            vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
            return { root, plan: await reviewed({ ...input, nativeIo: projectNativeSystemIo }) };
        }
        const { plan: first } = await installed(a.input);
        const { root: secondInstallation, plan: second } = await installed(b.input);
        expect(first.reviewedEffect.commands).toMatchObject([{ args: ['run', 'setup'], toolchain: { tool: 'npm', version: '4.6.0' } }]);
        expect(second.reviewedEffectDigest).toBe(first.reviewedEffectDigest);
        expect(JSON.stringify(first.reviewedEffect)).not.toContain('installed-npm');
        expect(JSON.stringify(first.reviewedEffect)).not.toContain('PATH');
        await writeFile(join(secondInstallation, 'installed-npm/package.json'), JSON.stringify({ name: 'npm', version: '4.7.0', bin: { npm: 'bin/npm.cjs' } }));
        expect(await reviewProjectSetupEffect({ ...b.input, nativeIo: projectNativeSystemIo }))
            .toMatchObject({ kind: 'refused', code: 'native_tool_version_mismatch' });
    });

    it('displays observed repository provenance without treating HEAD, branch, or file cleanliness as consent', async () => {
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-setup-provenance-' });
        roots.push(repository.rootPath);
        const { input } = await fixture({ version: 1 });
        await mkdir(join(repository.rootPath, '.happier'));
        const manifest = { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } };
        await writeFile(join(repository.rootPath, '.happier/project.json'), JSON.stringify(manifest));
        const registration = createGitScmBackendRuntimeRegistration();
        const scmRegistry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
            executableDefinition: registration.runtime!, registration,
            // The genuine registered Git snapshot requires the same hosting-service owner as production.
            hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({
                contributes: {}, scmHostingProvidersById: new Map(),
            }),
        })]);
        const workspace = { ...input.workspace, rootPath: repository.rootPath };
        const provenanceInput = { ...input, workspace, projectAssociation: { ...input.projectAssociation, workspace }, scmRegistry };
        const untracked = await reviewed(provenanceInput);
        expect(untracked.reviewedEffect).toMatchObject({ presentation: { provenance: {
            file: '.happier/project.json', kind: 'repository', headCommit: repository.headCommit,
            branch: repository.branchName, fileState: 'untracked',
        } } });
        // Temporary-repository fixture mutations never touch the shared checkout.
        runScmExecutable(repository.rootPath, 'git', ['add', '.happier/project.json']);
        runScmExecutable(repository.rootPath, 'git', ['commit', '-m', 'record project fixture']);
        const clean = await reviewed(provenanceInput);
        expect(clean.reviewedEffect).toMatchObject({ presentation: { provenance: {
            headCommit: runScmExecutable(repository.rootPath, 'git', ['rev-parse', 'HEAD']), fileState: 'unknown',
        } } });
        expect(clean.reviewedEffectDigest).toBe(untracked.reviewedEffectDigest);
        await writeFile(join(repository.rootPath, '.happier/project.json'), JSON.stringify({ ...manifest, futureMetadata: 'display only' }));
        const modified = await reviewed(provenanceInput);
        expect(modified.reviewedEffect).toMatchObject({ presentation: { provenance: { fileState: 'modified' } } });
        expect(modified.reviewedEffectDigest).toBe(clean.reviewedEffectDigest);
        await writeFile(join(repository.rootPath, repository.trackedPath), 'unrelated change\n');
        runScmExecutable(repository.rootPath, 'git', ['add', repository.trackedPath]);
        runScmExecutable(repository.rootPath, 'git', ['commit', '-m', 'unrelated fixture commit']);
        runScmExecutable(repository.rootPath, 'git', ['branch', '-m', 'display/renamed']);
        const movedHead = await reviewed(provenanceInput);
        expect(movedHead.reviewedEffect).toMatchObject({ presentation: { provenance: {
            headCommit: runScmExecutable(repository.rootPath, 'git', ['rev-parse', 'HEAD']), branch: 'display/renamed', fileState: 'modified',
        } } });
        expect(movedHead.reviewedEffectDigest).toBe(modified.reviewedEffectDigest);
        expect(movedHead.executionEnvironmentEffectDigest).toBe(modified.executionEnvironmentEffectDigest);
        const outside = { ...input, scmRegistry };
        const nonRepository = await reviewed(outside);
        expect(nonRepository.reviewedEffect).toMatchObject({ presentation: { provenance: {
            file: '.happier/project.json', kind: 'nonRepository', fileState: 'unknown',
        } } });
        expect(JSON.stringify(nonRepository.reviewedEffect)).not.toContain(repository.headCommit);
        const withoutScmBackend = { ...input, scmRegistry: createScmBackendRegistry([]) };
        const unavailable = await reviewed(withoutScmBackend);
        expect(unavailable.reviewedEffect).toMatchObject({ presentation: { provenance: {
            file: '.happier/project.json', kind: 'unavailable', fileState: 'unknown',
        } } });
        expect(JSON.stringify(unavailable.reviewedEffect)).not.toContain(repository.headCommit);
    });

    it('reviews ordered real native/literal commands across accepted Machines without running anything or hashing unrelated metadata', async () => {
        const manifest = { version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, workspace: { setup: [
            { kind: 'native', tool: 'make', file: 'Makefile', target: 'setup' },
            { kind: 'command', command: 'touch should-not-exist', cwd: '.' },
        ], setupInputs: ['input.bin'] }, scripts: { unrelated: { source: { kind: 'command', command: 'old unrelated' } } }, futureMetadata: 'old' };
        const files = { Makefile: 'setup:\n\techo prepared\n', 'input.bin': Buffer.from([0xff, 0]), 'mise.toml': '[tools]\nnode = "22"\n' };
        const a = await fixture(manifest, files);
        const b = await fixture({ ...manifest, scripts: {}, futureMetadata: 'changed' }, files);
        const first = await reviewed(a.input);
        const second = await reviewed({ ...b.input, workspace: { ...b.input.workspace, machineId: 'teammate', label: 'other label', createdAtMs: 2 },
            projectAssociation: { ...b.input.projectAssociation, workspace: { ...b.input.workspace, machineId: 'teammate', label: 'other label', createdAtMs: 2 } } });
        expect(first.commands.map(command => command.kind)).toEqual(['native', 'literal']);
        expect(first.commands[0]).toMatchObject({ resolution: { command: '/managed/make', args: ['-f', join(a.root, 'Makefile'), 'setup'], cwd: a.root } });
        expect(first.reviewedEffectDigest).toBe(second.reviewedEffectDigest);
        expect(first.executionEnvironmentEffectDigest).toBe(second.executionEnvironmentEffectDigest);
        const relocatedTool = await reviewed({ ...a.input, nativeIo: { resolveTool: async tool => ({ executablePath: `/other-installed/${tool}`, version: '1' }) } });
        expect(relocatedTool.reviewedEffectDigest).toBe(first.reviewedEffectDigest);
        expect(relocatedTool.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        const changedTool = await reviewed({ ...a.input, nativeIo: { resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '2' }) } });
        expect(changedTool.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedTool.executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);
        const changedSetupTool = await reviewed({ ...a.input, nativeIo: { resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: tool === 'make' ? '2' : '1' }) } });
        expect(changedSetupTool.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedSetupTool.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        expect(JSON.stringify(first.reviewedEffect)).not.toContain(a.root);
        expect(first.successBasis.cwd).toBe(a.root);
        expect(second.successBasis.cwd).toBe(b.root);
        await expect(access(join(a.root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(join(a.root, 'input.bin'), Buffer.from([0xfe, 0]));
        const changedInput = await reviewed(a.input);
        expect(changedInput.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedInput.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        await writeFile(join(a.root, 'input.bin'), files['input.bin']);
        await writeFile(join(a.root, 'Makefile'), 'setup:\n\techo changed\n');
        const changedSetupDefinition = await reviewed(a.input);
        expect(changedSetupDefinition.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedSetupDefinition.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        await writeFile(join(a.root, 'Makefile'), files.Makefile);
        await writeFile(join(a.root, '.happier/project.json'), JSON.stringify({ ...manifest, workspace: { ...manifest.workspace,
            setup: [{ kind: 'command', command: 'echo new setup' }],
        } }));
        const changedSetupCommand = await reviewed(a.input);
        expect(changedSetupCommand.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedSetupCommand.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        await writeFile(join(a.root, '.happier/project.json'), JSON.stringify(manifest));
        await writeFile(join(a.root, 'mise.toml'), '[tools]\nnode = "24"\n');
        const changedEnvironmentConfig = await reviewed(a.input);
        expect(changedEnvironmentConfig.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedEnvironmentConfig.executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);
        await writeFile(join(a.root, '.happier/project.json'), JSON.stringify({ ...manifest, environment: { kind: 'host' } }));
        expect((await reviewed(a.input)).executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);
    });

    it('uses only exact requester Project trust, distinguishes pending/skip, and reads target completion separately', async () => {
        const { root, input } = await fixture({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const plan = await reviewed(input);
        const post = trustTransport(null);
        expect(await prepareProjectSetup(input)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required', plan: { reviewedEffectDigest: plan.reviewedEffectDigest } });
        post.mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: {
            project: input.projectAssociation.project, reviewedEffectDigest: plan.reviewedEffectDigest, approvedAtMs: 1,
        } } } });
        const successHomeDir = join(root, 'local-success');
        expect(await prepareProjectSetup({ ...input, successHomeDir })).toMatchObject({ kind: 'prepared', previousSuccess: false });
        const store = createProjectSetupSuccessStore({ homeDir: successHomeDir });
        const target = { serverId: 'home', machineId: 'machine-a', workspaceRefId: 'workspace' };
        expect(await store.read(target)).toBeNull();
        await store.recordCompletion(target, { v: 1, workspaceRefId: 'workspace', completedAtMs: 1, ...plan.successBasis });
        expect(await prepareProjectSetup({ ...input, successHomeDir })).toMatchObject({ kind: 'prepared', previousSuccess: true });
        expect(await prepareProjectSetup({ ...input, skipForInvocation: true, successHomeDir })).toMatchObject({ kind: 'skippedForInvocation' });
        await writeFile(join(root, '.happier/project.json'), '{"version":1,"workspace":{"setup":[{"kind":"command","command":"echo changed"}]}}');
        expect(await prepareProjectSetup({ ...input, expectedEffectDigest: plan.reviewedEffectDigest })).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_effect_changed' });
        expect(await prepareProjectSetup(input)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required' });
    });

    it('prepares an admitted child with its inherited manifest while its physical controller is offline', async () => {
        const { root, input } = await fixture({ version: 1, devcontainer: {} });
        const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: root,
            storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: root } };
        const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
            parentMachineId: 'controller' }, observation };
        const metadata = { host: 'child', platform: 'linux', homeDir: '/home/coder', username: 'coder',
            happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier', devcontainerChild: projection };
        const row = { id: 'managed-child', homeId: 'home', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'controller-installation' },
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                value: {}, devcontainerObservation: observation }, allocation: 'bound', creationState: 'active',
            enrolledMachineId: input.workspace.machineId, desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/controller')) throw new Error('Controller offline');
            return { status: 200, data: { machine: { id: input.workspace.machineId, active: true,
                installationId: 'child-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                devcontainerChild: projection, metadata: encodePlainMachineStoredContent(metadata), metadataVersion: 1, daemonStateVersion: 0, daemonState: null } } };
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: row });
        expect(await reviewProjectSetupEffect(input)).toMatchObject({ kind: 'reviewed', plan: { workspace: input.workspace } });
        // A rebuilt native projection does not make the previously admitted root current.
        observation.workspaceFolder = observation.storage.childPath = '/replacement-child-root';
        expect(await reviewProjectSetupEffect(input)).toMatchObject({ kind: 'refused', code: 'child_required' });
    });

    it('refuses mismatched accepted identity and child selection before any host command/tool/secret work', async () => {
        const { input } = await fixture({ version: 1, devcontainer: {}, workspace: { setup: [{ kind: 'native', tool: 'make', file: 'Makefile', target: 'setup' }] } });
        vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : { status: 200, data: { machine: { id: input.workspace.machineId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadataVersion: 1, daemonStateVersion: 0, daemonState: null, metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux',
                    homeDir: '/home/user', happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' }) } } });
        const resolveTool = vi.fn(input.nativeIo.resolveTool);
        expect(await reviewProjectSetupEffect({ ...input, nativeIo: { resolveTool } })).toEqual({ kind: 'refused', code: 'child_required' });
        expect(resolveTool).not.toHaveBeenCalled();
        for (const field of ['id', 'serverId', 'machineId', 'rootPath', 'projectKey'] as const) {
            expect(await reviewProjectSetupEffect({ ...input, projectAssociation: { ...input.projectAssociation, workspace: { ...input.workspace, [field]: 'mismatch' } } })).toEqual({ kind: 'refused', code: 'project_workspace_association_mismatch' });
        }
        for (const field of ['serverId', 'projectId'] as const) {
            expect(await reviewProjectSetupEffect({ ...input, projectAssociation: { ...input.projectAssociation, project: { ...input.projectAssociation.project, [field]: 'other-project' } } })).toEqual({ kind: 'refused', code: 'project_workspace_association_mismatch' });
        }
    });

    it('skip cannot bypass a missing selected tool/config/secret binding and contained inputs reject symlink escapes', async () => {
        const native = await fixture({ version: 1, workspace: { setup: [{ kind: 'native', tool: 'make', file: 'Makefile', target: 'setup' }] } }, { Makefile: 'setup:\n\techo setup\n' });
        expect(await prepareProjectSetup({ ...native.input, skipForInvocation: true, nativeIo: { resolveTool: async () => null } })).toMatchObject({ kind: 'refused', code: 'native_tool_unavailable' });
        const env = await fixture({ version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'missing.toml' } });
        expect(await prepareProjectSetup({ ...env.input, skipForInvocation: true })).toMatchObject({ kind: 'refused', code: 'native_configuration_missing' });
        const secret = await fixture({ version: 1, environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }] });
        expect(await prepareProjectSetup({ ...secret.input, skipForInvocation: true })).toMatchObject({ kind: 'refused', code: 'project_environment_binding_unavailable' });
        const contained = await fixture({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }], setupInputs: ['escape.bin'] } });
        await symlink(join(native.root, 'Makefile'), join(contained.root, 'escape.bin'));
        expect(await reviewProjectSetupEffect(contained.input)).toMatchObject({ kind: 'refused', code: 'outside_root' });
    });

    it('reviews binding identities and selected nonsecret config without storing or digesting secret values or unrelated Settings', async () => {
        const { input } = await fixture({ version: 1, environmentVariables: [
            { name: 'TOKEN', kind: 'secret', required: true }, { name: 'REGION', kind: 'config', required: true },
        ], workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const bindingInput = { ...input, environmentBindings: { v: 1 as const, bindings: { TOKEN: { ref: 'token-a' } } },
            configEnvironment: { REGION: 'eu', UNUSED: 'irrelevant' },
            secretEnvironment: { accountSettings: { secrets: [{ id: 'token-a', name: 'Dev Postgres', encryptedValue: { _isSecretValue: true, value: 'private-secret' } }], unrelated: 1 }, settingsSecretsReadKeys: [] },
        };
        const first = await reviewed(bindingInput);
        const rotated = await reviewed({ ...bindingInput, secretEnvironment: { ...bindingInput.secretEnvironment,
            accountSettings: { secrets: [{ id: 'token-a', name: 'Renamed Postgres', encryptedValue: { _isSecretValue: true, value: 'rotated-secret' } }], unrelated: 999 },
        }, configEnvironment: { REGION: 'eu', UNUSED: 'changed' } });
        expect(rotated.reviewedEffectDigest).toBe(first.reviewedEffectDigest);
        expect(rotated.executionEnvironmentEffectDigest).toBe(first.executionEnvironmentEffectDigest);
        expect(first.reviewedEffect).toMatchObject({ presentation: { bindings: [
            { name: 'TOKEN', ref: 'token-a', source: 'personal', displayName: 'Dev Postgres' },
        ] } });
        expect(rotated.reviewedEffect).toMatchObject({ presentation: { bindings: [
            { name: 'TOKEN', ref: 'token-a', source: 'personal', displayName: 'Renamed Postgres' },
        ] } });
        expect(JSON.stringify(first.reviewedEffect)).not.toContain('private-secret');
        expect(JSON.stringify(first.successBasis)).not.toContain('private-secret');
        expect(JSON.stringify(first)).not.toContain('private-secret');
        expect(first.successBasis.environmentBindingReferences).toEqual(['{"name":"TOKEN","ref":"token-a"}']);
        const changed = await reviewed({ ...bindingInput, environmentBindings: { v: 1, bindings: { TOKEN: { ref: 'token-b' } } },
            secretEnvironment: { accountSettings: { secrets: [{ id: 'token-b', encryptedValue: { _isSecretValue: true, value: 'private-secret' } }] }, settingsSecretsReadKeys: [] },
        });
        expect(changed.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changed.executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);
        const changedConfig = await reviewed({ ...bindingInput, configEnvironment: { REGION: 'us' } });
        expect(changedConfig.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedConfig.executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);

        const shared = await fixture({ version: 1, environmentVariables: [{ name: 'SENTRY_AUTH_TOKEN', kind: 'secret', required: true }] });
        const resource = { resourceId: 'sentry', ownerAccountId: 'owner', displayName: 'Sentry', kind: 'token' as const,
            encryptionMode: 'plain' as const, revision: 4, materialStatus: 'ready' as const,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'sentry', mode: 'plain',
                content: { v: 1, name: 'Sentry', kind: 'token', value: 'private-shared-token' } }),
        };
        const sharedInput = { ...shared.input,
            environmentBindings: { v: 1 as const, bindings: { SENTRY_AUTH_TOKEN: { ref: 'happier:shared-secret:v1:sentry', revision: 4 } } },
            secretEnvironment: { accountSettings: {}, settingsSecretsReadKeys: [], savedSecretResources: [resource] },
        };
        const sharedPlan = await reviewed(sharedInput);
        expect(sharedPlan.reviewedEffect).toMatchObject({ presentation: { bindings: [
            { name: 'SENTRY_AUTH_TOKEN', ref: 'happier:shared-secret:v1:sentry', revision: 4, source: 'shared_resource', displayName: 'Sentry' },
        ] } });
        expect(JSON.stringify(sharedPlan)).not.toContain('private-shared-token');
        const renamedShared = await reviewed({ ...sharedInput, secretEnvironment: { ...sharedInput.secretEnvironment,
            savedSecretResources: [{ ...resource, displayName: 'Sentry production',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'sentry', mode: 'plain',
                    content: { v: 1, name: 'Sentry production', kind: 'token', value: 'rotated-shared-token' } }),
            }],
        } });
        expect(renamedShared.reviewedEffectDigest).toBe(sharedPlan.reviewedEffectDigest);
        expect(renamedShared.executionEnvironmentEffectDigest).toBe(sharedPlan.executionEnvironmentEffectDigest);
        expect(renamedShared.reviewedEffect).toMatchObject({ presentation: { bindings: [{ displayName: 'Sentry production' }] } });
        expect(await reviewProjectSetupEffect({ ...sharedInput, secretEnvironment: { ...sharedInput.secretEnvironment,
            savedSecretResources: [{ ...resource, displayName: 'unauthenticated-name' }],
        } })).toMatchObject({ kind: 'refused', code: 'project_environment_binding_unavailable' });
    });

    it('reviews teardown independently of setup trust and distinguishes empty/platform-inapplicable preparation', async () => {
        const { input } = await fixture({ version: 1, workspace: {
            setup: [{ kind: 'command', command: 'echo setup' }], teardown: [{ kind: 'command', command: 'echo teardown' }],
        } });
        const setup = await reviewed(input);
        const teardownInput = { ...input, purpose: 'teardown' as const };
        const teardown = await reviewed(teardownInput);
        expect(teardown.reviewedEffectDigest).not.toBe(setup.reviewedEffectDigest);
        expect(teardown.executionEnvironmentEffectDigest).toBe(setup.executionEnvironmentEffectDigest);
        trustTransport(setup.reviewedEffectDigest);
        expect(await prepareProjectSetup(teardownInput)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required' });
        const inapplicable = await fixture({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo Windows setup', platforms: ['windows'] }] } });
        expect(await prepareProjectSetup(inapplicable.input)).toMatchObject({ kind: 'notRequired', plan: { commands: [] } });
        const absent = await fixture({ version: 1 });
        expect(await prepareProjectSetup(absent.input)).toMatchObject({ kind: 'notRequired' });
    });

    it('consumes exact current host human effect consent this time without granting remembered trust or accepting an invocation waiver', async () => {
        const { input } = await fixture({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const plan = await reviewed(input);
        const post = trustTransport(null);
        const decision = { authority: 'present_user' as const, project: input.projectAssociation.project, reviewedEffectDigest: plan.reviewedEffectDigest };
        const thisTime = { ...input, effectDecision: decision };
        expect(await prepareProjectSetup(thisTime)).toMatchObject({ kind: 'prepared', consent: 'thisTime', previousSuccess: false });
        expect(post).not.toHaveBeenCalled();
        const stale = { ...input, effectDecision: { ...decision, reviewedEffectDigest: 'stale' } };
        expect(await prepareProjectSetup(stale)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_effect_changed' });
        const wrongProject = { ...input, effectDecision: { ...decision, project: { ...decision.project, projectId: 'other-project' } } };
        expect(await prepareProjectSetup(wrongProject)).toMatchObject({ kind: 'refused', code: 'project_setup_consent_invalid' });
        // Untyped ingress cannot manufacture the host's authenticated human-decision fact.
        const automated = { ...input, effectDecision: { ...decision, authority: 'account_automation' } as unknown as typeof decision };
        expect(await prepareProjectSetup(automated)).toMatchObject({ kind: 'pendingApproval', code: 'project_setup_consent_required' });
        expect(post).not.toHaveBeenCalled();
    });

    it('reviews a selected external environment through the canonical lease without evaluating it and binds its installed adapter provenance', async () => {
        const { input } = await fixture({ version: 1, environment: importedPixiEnvironment }, { 'pixi.toml': '[tasks]\ncheck = "echo checked"' });
        const produceEnvironment = vi.fn(pixiRuntime.produceEnvironment);
        async function reviewInstalled(version: string) {
            const ingested = ingestCanonicalPluginManifest({ ...pixiPlugin.manifest, version }, { sourceProvenance: 'registryCustodied' });
            if (!ingested.ok) throw new Error('Expected admitted external fixture');
            const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: pixiAdapter.pluginId,
                manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.js',
                sourceSpec: { kind: 'package' as const, locator: '@acme/pixi', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
                activationEvents: [], manifest: ingested.manifest }];
            const registry = await activatePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({ activationTargets: targets }),
                occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, createPluginRuntimeOccurrenceId(pixiAdapter.pluginId)]]), generation: 1,
                // External module loading is the filesystem boundary; real registration/activation/lease logic remains below it.
                resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@acme/pixi/daemon', load: async () => ({ activate(api: PluginApi) {
                    api.projectNativeAdapters.register(pixiAdapter.localId, { ...pixiRuntime, produceEnvironment });
                } }) }),
            });
            try {
                const plan = await reviewed({ ...input, plugins: {
                    resolveProjectNativeAdapter: (reference, role) => resolveProjectNativeAdapter({ reference, role, targets, registry }),
                } });
                expect(plan.environmentAdapterLease?.isCurrent()).toBe(true);
                return { reviewedEffectDigest: plan.reviewedEffectDigest, executionEnvironmentEffectDigest: plan.executionEnvironmentEffectDigest };
            } finally { await registry.dispose(); }
        }
        const first = await reviewInstalled('1.0.0');
        expect(await reviewInstalled('1.0.0')).toEqual(first);
        const changedAdapter = await reviewInstalled('2.0.0');
        expect(changedAdapter.reviewedEffectDigest).not.toBe(first.reviewedEffectDigest);
        expect(changedAdapter.executionEnvironmentEffectDigest).not.toBe(first.executionEnvironmentEffectDigest);
        expect(produceEnvironment).not.toHaveBeenCalled();
    });
});
