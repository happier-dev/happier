import { access, chmod, constants, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
    ExecLaunchInputV1,
} from '../exec/privateContract';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginEnvService } from './env';
import { createPluginExecService } from '../exec/hostService';
import { createPluginFsService } from './fs';
import { createPluginSecretStore, preparePluginSecretsDataRemoval } from './secrets';
import {
    copyPluginSessionStorageForFork,
    createAccountSettingsBackedPluginStorageScope,
    createPluginStoragePublicShareSnapshot,
    createPluginStorageOwner,
    preparePluginStorageDataRemoval,
    updatePluginStorageScopeValueAtomically,
} from './storage';
import { createPluginTerminalHostService } from './terminalHost';
import { createPluginTranscriptFileFollowService } from './transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './transcripts/fileFollowGrants';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';
import type {
    TerminalControlPort,
    TerminalHostAdapter,
    TerminalHostHandle,
    TerminalInputInjectionResult,
    TerminalPromptInput,
} from '@happier-dev/agents';

async function makeHappyHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-a11-'));
}

async function firstExecutablePath(candidates: readonly string[]): Promise<string> {
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Try the next platform-specific candidate.
        }
    }
    throw new Error(`No executable candidate found: ${candidates.join(', ')}`);
}

describe('A.11 plugin context services', () => {
    it('scopes storage by plugin id and keeps ephemeral/session/local/synced behavior distinct', async () => {
        const happyHomeDir = await makeHappyHome();
        const syncedValues = new Map<string, unknown>();
        const service = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            sessionId: 'session-source',
            synced: {
                get: async <T = unknown>(key: string): Promise<T | null> =>
                    syncedValues.has(key) ? syncedValues.get(key) as T : null,
                set: async (key, value) => {
                    syncedValues.set(key, value);
                },
                delete: async (key) => {
                    syncedValues.delete(key);
                },
                listKeys: async () => [...syncedValues.keys()],
            },
        });

        await service.ephemeral.set('volatile', { ok: true });
        await service.session.set('turn', { session: true });
        await service.local.set('durable', { local: true });
        await service.synced.set('account', { synced: true });

        expect(await service.ephemeral.get('volatile')).toEqual({ ok: true });
        expect(await service.session.get('turn')).toEqual({ session: true });
        expect(await service.local.get('durable')).toEqual({ local: true });
        expect(await service.synced.get('account')).toEqual({ synced: true });

        const restarted = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            sessionId: 'session-source',
        });
        expect(await restarted.ephemeral.get('volatile')).toBeNull();
        expect(await restarted.session.get('turn')).toEqual({ session: true });
        expect(await restarted.local.get('durable')).toEqual({ local: true });
        await expect(restarted.synced.get('account')).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_SYNCED_UNAVAILABLE',
        });
    });

    it('deep-copies session storage on fork and strips it from public share snapshots', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const source = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-source',
        });
        await source.session.set('draft', { nested: { value: 1 } });
        await source.local.set('deviceOnly', { value: true });

        await copyPluginSessionStorageForFork({
            paths,
            sourceSessionId: 'session-source',
            targetSessionId: 'session-target',
        });
        await source.session.set('draft', { nested: { value: 2 } });

        const target = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-target',
        });
        expect(await target.session.get('draft')).toEqual({ nested: { value: 1 } });

        const unbound = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
        });
        await expect(unbound.session.listKeys()).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
        });
        await expect(createPluginStoragePublicShareSnapshot({ paths })).resolves.toEqual({
            t: 'happier_plugin_public_share_storage_snapshot_v1',
            plugins: [],
        });
    });

    it('backs synced storage with account settings while preserving unknown account fields', async () => {
        let settings: Record<string, unknown> = { existing: true };
        const synced = createAccountSettingsBackedPluginStorageScope({
            pluginId: 'acme.plugin',
            getSettings: () => settings,
            updateSettings: async (mutate) => {
                settings = mutate(settings);
                return settings;
            },
        });

        await synced.set('shared', { ok: true });

        expect(await synced.get('shared')).toEqual({ ok: true });
        expect(await synced.listKeys()).toEqual(['shared']);
        expect(settings.existing).toBe(true);

        await synced.delete('shared');
        expect(await synced.get('shared')).toBeNull();
    });

    it('atomically updates one synced key through the account settings owner', async () => {
        let settings: Record<string, unknown> = {
            existing: true,
            pluginStorageSyncedV1: {
                v: 1,
                plugins: {
                    'acme.plugin': {
                        settings: { revision: 0 },
                        untouched: { keep: true },
                    },
                    'sibling.plugin': { settings: { keep: true } },
                },
            },
        };
        const synced = createAccountSettingsBackedPluginStorageScope({
            pluginId: 'acme.plugin',
            getSettings: () => settings,
            updateSettings: async (mutate) => {
                settings = mutate(settings);
                return settings;
            },
        });

        const revision = await updatePluginStorageScopeValueAtomically({
            scope: synced,
            key: 'settings',
            operation: (current) => ({
                value: { revision: 1, previous: current },
                result: 1,
            }),
        });

        expect(revision).toBe(1);
        expect(await synced.get('settings')).toEqual({
            revision: 1,
            previous: { revision: 0 },
        });
        expect(settings).toMatchObject({
            existing: true,
            pluginStorageSyncedV1: {
                plugins: {
                    'acme.plugin': { untouched: { keep: true } },
                    'sibling.plugin': { settings: { keep: true } },
                },
            },
        });
    });

    it('removes only one validated plugin storage/settings/session/filesystem and secret namespace', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        let accountSettings: Record<string, unknown> = { existing: true };
        const accountSettingsAdapter = {
            getSettings: () => accountSettings,
            updateSettings: async (mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>) => {
                accountSettings = mutate(accountSettings);
                return accountSettings;
            },
        };
        const acme = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-1',
            synced: createAccountSettingsBackedPluginStorageScope({ pluginId: 'acme.plugin', ...accountSettingsAdapter }),
        });
        const sibling = createPluginStorageOwner({
            pluginId: 'sibling.plugin',
            paths,
            sessionId: 'session-1',
            synced: createAccountSettingsBackedPluginStorageScope({ pluginId: 'sibling.plugin', ...accountSettingsAdapter }),
        });
        await acme.local.set('settings', { enabled: true });
        await acme.session.set('draft', { text: 'remove me' });
        await acme.synced.set('profile', { id: 'remove-me' });
        await sibling.local.set('settings', { enabled: false });
        await sibling.session.set('draft', { text: 'keep me' });
        await sibling.synced.set('profile', { id: 'keep-me' });
        accountSettings = {
            ...accountSettings,
            pluginStorageSyncedV1: {
                ...(accountSettings.pluginStorageSyncedV1 as Record<string, unknown>),
                futureEnvelopeField: { keep: true },
            },
        };
        await mkdir(join(paths.storageDir, 'acme.plugin', 'fs'), { recursive: true });
        await writeFile(join(paths.storageDir, 'acme.plugin', 'fs', 'owned.txt'), 'remove me', 'utf8');

        const acmeSecrets = createPluginSecretStore({ pluginId: 'acme.plugin', paths });
        const siblingSecrets = createPluginSecretStore({ pluginId: 'sibling.plugin', paths });
        await acmeSecrets.set('token', 'remove-me');
        await siblingSecrets.set('token', 'keep-me');

        const storageRemoval = await preparePluginStorageDataRemoval({
            pluginId: 'acme.plugin',
            paths,
            synced: accountSettingsAdapter,
        });
        const secretsRemoval = await preparePluginSecretsDataRemoval({ pluginId: 'acme.plugin', paths });
        await storageRemoval.removeSynced();
        await storageRemoval.removeLocal();
        await secretsRemoval.remove();

        const restartedAcme = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-1',
            synced: createAccountSettingsBackedPluginStorageScope({ pluginId: 'acme.plugin', ...accountSettingsAdapter }),
        });
        expect(await restartedAcme.local.listKeys()).toEqual([]);
        expect(await restartedAcme.session.listKeys()).toEqual([]);
        expect(await restartedAcme.synced.listKeys()).toEqual([]);
        expect(await createPluginSecretStore({ pluginId: 'acme.plugin', paths }).list()).toEqual([]);

        expect(await sibling.local.get('settings')).toEqual({ enabled: false });
        expect(await sibling.session.get('draft')).toEqual({ text: 'keep me' });
        expect(await sibling.synced.get('profile')).toEqual({ id: 'keep-me' });
        expect(await siblingSecrets.get('token')).toBe('keep-me');
        expect(accountSettings.existing).toBe(true);
        expect(accountSettings).toMatchObject({
            pluginStorageSyncedV1: { futureEnvelopeField: { keep: true } },
        });
        await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).resolves.toBeUndefined();
    });

    it('rejects ambiguous identities and symlinked plugin namespaces before any destructive mutation', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        let accountSettings: Record<string, unknown> = {
            pluginStorageSyncedV1: {
                v: 1,
                plugins: { 'sibling.plugin': { keep: true } },
            },
        };
        const updateSettings = vi.fn(async (
            mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        ) => {
            accountSettings = mutate(accountSettings);
            return accountSettings;
        });
        const synced = { getSettings: () => accountSettings, updateSettings };

        await expect(preparePluginStorageDataRemoval({
            pluginId: '../sibling.plugin',
            paths,
            synced,
        })).rejects.toMatchObject({ code: 'PLUGIN_DATA_REMOVAL_IDENTITY_INVALID' });

        const outside = join(happyHomeDir, 'outside-plugin-data');
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8');
        await mkdir(paths.storageDir, { recursive: true });
        await symlink(outside, join(paths.storageDir, 'acme.plugin'), process.platform === 'win32' ? 'junction' : 'dir');

        await expect(preparePluginStorageDataRemoval({
            pluginId: 'acme.plugin',
            paths,
            synced,
        })).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_DATA_PATH_INVALID' });
        expect(updateSettings).not.toHaveBeenCalled();
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
        expect(accountSettings).toMatchObject({
            pluginStorageSyncedV1: { plugins: { 'sibling.plugin': { keep: true } } },
        });
    });

    it('stores secrets per plugin namespace without exposing values in list output', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const fixedKey = new Uint8Array(32).fill(7);
        const randomBytes = (length: number) => new Uint8Array(length).fill(3);
        const left = createPluginSecretStore({
            pluginId: 'left.plugin',
            paths,
            secretKey: fixedKey,
            randomBytes,
        });
        const right = createPluginSecretStore({
            pluginId: 'right.plugin',
            paths,
            secretKey: fixedKey,
            randomBytes,
        });

        await left.set('shared-name', 'left-secret');
        await right.set('shared-name', 'right-secret');

        expect(await left.get('shared-name')).toBe('left-secret');
        expect(await right.get('shared-name')).toBe('right-secret');
        expect(await left.list()).toEqual([{ name: 'shared-name' }]);

        const secretFile = join(paths.secretsDir, 'left.plugin', 'secrets.v1.json');
        const raw = await readFile(secretFile, 'utf8');
        expect(raw).not.toContain('left-secret');
        if (process.platform !== 'win32') {
            expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
        }
    });

    it('serializes concurrent secret writes from separate service instances without losing names', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const first = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const second = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            randomBytes: (length) => new Uint8Array(length).fill(4),
        });

        await Promise.all([
            first.set('api-token', 'first-secret'),
            second.set('signing-key', 'second-secret'),
        ]);

        expect(await first.list()).toEqual([
            { name: 'api-token' },
            { name: 'signing-key' },
        ]);
        expect(await first.get('api-token')).toBe('first-secret');
        expect(await first.get('signing-key')).toBe('second-secret');
    });

    it('persists a prototype-named generic local storage key as an own value', async () => {
        const happyHomeDir = await makeHappyHome();
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });

        await storage.local.set('__proto__', { persisted: true });

        expect(await storage.local.get('__proto__')).toEqual({ persisted: true });
        expect(await storage.local.listKeys()).toEqual(['__proto__']);
    });

    it('persists a prototype-named secret as an own encrypted record', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            secretKey: new Uint8Array(32).fill(7),
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });

        await secrets.set('__proto__', 'secret-value');

        expect(await secrets.list()).toEqual([{ name: '__proto__' }]);
        expect(await secrets.get('__proto__')).toBe('secret-value');
    });

    it('does not create local secret key material for a missing secret read', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
        });

        await expect(secrets.get('missing')).resolves.toBeNull();
        await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('does not create local secret key material for a missing prototype-named secret read', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
        });

        await expect(secrets.get('__proto__')).resolves.toBeNull();
        await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it.each([
        {
            name: 'malformed encrypted entry',
            rawSecret: {
                _isSecretValue: true,
                encryptedValue: { t: 'invalid-envelope', c: 'not-secret-material' },
            },
        },
        {
            name: 'plaintext secret entry',
            rawSecret: {
                _isSecretValue: true,
                value: 'unexpected-plaintext',
            },
        },
    ])('fails closed without rewriting the secrets record when it contains a $name', async ({ rawSecret }) => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secretFile = join(paths.secretsDir, 'acme.plugin', 'secrets.v1.json');
        const original = `${JSON.stringify({
            t: 'happier_plugin_secrets_v1',
            secrets: {
                corrupted: rawSecret,
            },
        }, null, 2)}\n`;
        await mkdir(join(paths.secretsDir, 'acme.plugin'), { recursive: true });
        await writeFile(secretFile, original, 'utf8');
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            secretKey: new Uint8Array(32).fill(7),
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });

        await expect(secrets.set('unrelated', 'new-secret')).rejects.toMatchObject({
            code: 'PLUGIN_SECRETS_FILE_INVALID',
            message: expect.stringContaining('acme.plugin/corrupted'),
        });
        expect(await readFile(secretFile, 'utf8')).toBe(original);
    });

    it('provides A.13 env and fs services through plugin-scoped access only', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const env = createPluginEnvService({
            env: {
                HAPPIER_ALLOWED: 'yes',
                SECRET_TOKEN: 'no',
            },
            allowedNames: ['HAPPIER_ALLOWED'],
        });
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
        });

        expect(env.get('HAPPIER_ALLOWED')).toBe('yes');
        expect(env.get('SECRET_TOKEN')).toBeNull();
        await fs.writeText({ path: 'notes/run.txt', contents: 'ok' });

        await expect(fs.readText({ path: 'notes/run.txt' })).resolves.toBe('ok');
        await expect(fs.writeText({ path: '../escape.txt', contents: 'no' })).rejects.toThrow(/escapes/);
    });

    it('exposes terminal host control only through a host-owned capability-gated wrapper', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const injected: TerminalInputInjectionResult = {
            status: 'injected',
            injectedAt: 123,
            bytesWritten: 5,
            hostKind: 'tmux',
            hostSessionName: 'claude-session',
            paneId: '0',
        };
        const createOrAttachHost = vi.fn<NonNullable<TerminalHostAdapter['createOrAttachHost']>>(async () => handle);
        const injectUserPrompt = vi.fn<NonNullable<TerminalHostAdapter['injectUserPrompt']>>(async () => injected);
        const boundHandle: TerminalHostHandle = {
            ...handle,
            attachmentId: 'attachment-plugin-host-1' as NonNullable<TerminalHostHandle['attachmentId']>,
        };
        const onHostCreated = vi.fn(async () => boundHandle);
        const disposeHost = vi.fn(async () => undefined);
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost,
            injectUserPrompt,
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 456 })),
            captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: 789 })),
            dispose: vi.fn(async () => undefined),
        };
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: (preference) => ({
                status: 'resolved',
                adapter,
                reason: preference === 'tmux' ? 'tmux_forced' : 'tmux_available',
            }),
            resolveAgentCliLaunch: (launch) => ({
                command: '/usr/local/bin/claude',
                args: ['--dangerously-skip-permissions'],
                env: {
                    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                    OPENAI_API_KEY: 'ambient-key',
                    CLAUDECODE: '1',
                    HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
                    HAPPIER_SERVER_URL: 'https://canonical.example.test',
                },
            }),
            onHostCreated,
            disposeHost,
        });

        await expect(service.resolve({ preference: 'auto' })).resolves.toEqual({
            status: 'resolved',
            hostKind: 'tmux',
            reason: 'tmux_available',
        });
        const terminalHandle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: {
                kind: 'agent-cli',
                agentId: 'claude',
                args: ['--continue'],
                env: {
                    EXTRA: '1',
                    HAPPIER_SESSION_PROFILE_ID: 'plugin-spoof',
                    HAPPIER_SERVER_URL: 'https://plugin-spoof.example.test',
                },
                unsetEnvKeys: ['openai_api_key'],
            },
            isolatedEnv: true,
        });
        expect(terminalHandle).toBe(boundHandle);
        const prompt: TerminalPromptInput = {
            text: 'hello',
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'nonce-1' },
            scheduling: {},
        };

        await expect(service.injectUserPrompt(terminalHandle, prompt)).resolves.toBe(injected);
        expect(createOrAttachHost).toHaveBeenCalledWith({
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            spawnArgv: ['/usr/local/bin/claude', '--dangerously-skip-permissions', '--continue'],
            spawnEnv: {
                CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                EXTRA: '1',
                HAPPIER_SERVER_URL: 'https://canonical.example.test',
            },
            unsetEnvKeys: ['openai_api_key'],
            isolatedEnv: true,
        });
        expect(injectUserPrompt).toHaveBeenCalledWith(boundHandle, {
            ...prompt,
            scheduling: { timeoutMs: 15_000 },
        });
        expect(onHostCreated).toHaveBeenCalledWith(handle);

        await service.dispose(terminalHandle, {
            kind: 'preserve_host',
            reason: 'runtime_recovery',
        });
        expect(disposeHost).toHaveBeenCalledWith({
            handle: boundHandle,
            adapter,
            intent: { kind: 'preserve_host', reason: 'runtime_recovery' },
        });
        expect(adapter.dispose).not.toHaveBeenCalled();

        const disabled = createPluginTerminalHostService({
            hasCapability: () => false,
            resolveTerminalHost: () => ({ status: 'disabled', reason: 'no_host_available', message: 'No host.' }),
            resolveAgentCliLaunch: () => {
                throw new Error('not reached');
            },
            disposeHost: vi.fn(async () => undefined),
        });
        await expect(disabled.resolve({ preference: 'auto' })).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED',
        });
        const missingPermission = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({
                command: '/usr/local/bin/claude',
                args: [],
            }),
            disposeHost: vi.fn(async () => undefined),
        });
        await expect(missingPermission.resolve({ preference: 'auto' })).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED',
        });
    });

    it('normalizes terminal prompt line endings before adapter injection', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const injectUserPrompt = vi.fn<NonNullable<TerminalHostAdapter['injectUserPrompt']>>(async () => ({
            status: 'injected',
            injectedAt: 123,
            bytesWritten: 5,
            hostKind: 'tmux',
            hostSessionName: 'claude-session',
            paneId: '0',
        }));
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async () => handle),
            injectUserPrompt,
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 456 })),
            dispose: vi.fn(async () => undefined),
        };
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
            disposeHost: vi.fn(async () => undefined),
        });

        const activeHandle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli', agentId: 'claude' },
            isolatedEnv: true,
        });
        await expect(service.injectUserPrompt(activeHandle, {
            text: 'alpha\r\nbeta\rgamma',
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'nonce-cr' },
            scheduling: {},
        })).resolves.toMatchObject({ status: 'injected' });

        expect(injectUserPrompt).toHaveBeenCalledWith(handle, {
            text: 'alpha\nbeta\ngamma',
            multiline: true,
            origin: { kind: 'ui_pending', nonce: 'nonce-cr' },
            scheduling: { timeoutMs: 15_000 },
        });
    });

    it('scales terminal prompt write timeout before adapter injection', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const injectUserPrompt = vi.fn<NonNullable<TerminalHostAdapter['injectUserPrompt']>>(async () => ({
            status: 'injected',
            injectedAt: 123,
            bytesWritten: 128_000,
            hostKind: 'tmux',
            hostSessionName: 'claude-session',
            paneId: '0',
        }));
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async () => handle),
            injectUserPrompt,
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 456 })),
            dispose: vi.fn(async () => undefined),
        };
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
            disposeHost: vi.fn(async () => undefined),
        });

        const activeHandle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli', agentId: 'claude' },
            isolatedEnv: true,
        });
        await expect(service.injectUserPrompt(activeHandle, {
            text: 'x'.repeat(128_000),
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'nonce-large' },
            scheduling: {},
        })).resolves.toMatchObject({ status: 'injected' });

        const injectedInput = injectUserPrompt.mock.calls[0]?.[1];
        expect(injectedInput?.scheduling.timeoutMs).toBeGreaterThan(15_000);
    });

    it('rejects terminal control bytes before prompt text reaches the active adapter', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const injectUserPrompt = vi.fn<NonNullable<TerminalHostAdapter['injectUserPrompt']>>(async () => ({
            status: 'injected',
            injectedAt: 123,
            bytesWritten: 5,
            hostKind: 'tmux',
            hostSessionName: 'claude-session',
            paneId: '0',
        }));
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async () => handle),
            injectUserPrompt,
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 456 })),
            dispose: vi.fn(async () => undefined),
        };
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
            disposeHost: vi.fn(async () => undefined),
        });
        const activeHandle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli', agentId: 'claude' },
            isolatedEnv: true,
        });
        const unsafePrompts = [
            ['nul', 'alpha\x00beta'],
            ['ctrl-c', 'alpha\x03beta'],
            ['ctrl-d', 'alpha\x04beta'],
            ['escape', 'alpha\x1bbeta'],
            ['csi', 'alpha\x1b[31mbeta'],
            ['osc', 'alpha\x1b]0;title\x07beta'],
            ['bracketed-paste-start', 'alpha\x1b[200~beta'],
            ['bracketed-paste-end', 'alpha\x1b[201~beta'],
        ] as const;

        for (const [caseName, text] of unsafePrompts) {
            await expect(service.injectUserPrompt(activeHandle, {
                text,
                multiline: false,
                origin: { kind: 'ui_pending', nonce: `nonce-${caseName}` },
                scheduling: {},
            })).resolves.toMatchObject({
                status: 'failed',
                reason: 'invalid_prompt_text',
                phase: 'before_write',
                duplicateRisk: 'none',
                recoverable: false,
                hostKind: 'tmux',
                hostSessionName: 'claude-session',
                paneId: '0',
            });
        }

        expect(injectUserPrompt).not.toHaveBeenCalled();
    });

    it('exposes the terminal control port through the active adapter and returns null when unsupported', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const controlPort: TerminalControlPort = {
            hostKind: 'tmux',
            sendLiteralText: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendRawSequence: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendSpecialKey: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            captureScreen: vi.fn(async () => ({
                status: 'captured' as const,
                capture: { text: '', capturedAtMs: 1, hostKind: 'tmux' as const },
            })),
        };
        const createControlPort = vi.fn<NonNullable<TerminalHostAdapter['createControlPort']>>(() => controlPort);
        const baseAdapter = {
            kind: 'tmux' as const,
            createOrAttachHost: vi.fn(async () => handle),
            injectUserPrompt: vi.fn(async (): Promise<TerminalInputInjectionResult> => ({
                status: 'injected',
                injectedAt: 1,
                bytesWritten: 1,
                hostKind: 'tmux',
                hostSessionName: 'claude-session',
                paneId: '0',
            })),
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
            dispose: vi.fn(async () => undefined),
        };
        const makeService = (adapter: TerminalHostAdapter) => createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
            disposeHost: vi.fn(async () => undefined),
        });
        const launchRequest = {
            preference: 'tmux' as const,
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli' as const, agentId: 'claude' },
            isolatedEnv: true,
        };

        const service = makeService({ ...baseAdapter, createControlPort });
        const activeHandle = await service.createOrAttachHost(launchRequest);
        await expect(service.controlPort(activeHandle)).resolves.toBe(controlPort);
        expect(createControlPort).toHaveBeenCalledWith(handle);

        const withoutControl = makeService(baseAdapter);
        const plainHandle = await withoutControl.createOrAttachHost(launchRequest);
        await expect(withoutControl.controlPort(plainHandle)).resolves.toBeNull();

        // Inactive handles must be rejected like every other handle-scoped method.
        await expect(makeService({ ...baseAdapter, createControlPort }).controlPort(handle)).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE',
        });
    });

    it('creates host-owned plugin temp directories with scoped read write and cleanup', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
        });

        const temp = await fs.createTempDirectory({ prefix: 'happier-deepsec-' });
        const textPath = await temp.createTextFile({
            suffix: '.files.txt',
            contents: 'src/auth.ts\n',
        });

        expect(textPath).toContain('happier-deepsec-');
        await expect(temp.readText({ path: textPath })).resolves.toBe('src/auth.ts\n');
        await expect(temp.createTextFile({ suffix: '/escape.txt', contents: 'no' })).rejects.toThrow(/suffix/);
        await expect(temp.readText({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(/escapes/);

        await temp.cleanup();
        await expect(stat(temp.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects plugin filesystem symlink escapes from the scoped root', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const rootDir = join(paths.storageDir, 'acme.plugin', 'fs');
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-a13-fs-outside-'));
        await mkdir(rootDir, { recursive: true });
        await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
        await symlink(outsideDir, join(rootDir, 'outside'), 'dir');
        const fs = createPluginFsService({
            rootDir,
        });

        await expect(fs.readText({ path: 'outside/secret.txt' })).rejects.toThrow(/escapes/);
        await expect(fs.writeText({ path: 'outside/new.txt', contents: 'no' })).rejects.toThrow(/escapes/);
        await expect(fs.list({ path: 'outside' })).rejects.toThrow(/escapes/);
        await expect(fs.stat({ path: 'outside/secret.txt' })).rejects.toThrow(/escapes/);
    });

    it('materializes scoped path list files from the host root and blocks symlink escapes', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const repoRoot = await mkdtemp(join(tmpdir(), 'happier-a11-scoped-repo-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-a11-scoped-outside-'));
        await mkdir(join(repoRoot, 'src'), { recursive: true });
        await writeFile(join(repoRoot, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf8');
        await writeFile(join(repoRoot, 'src', 'api.ts'), 'export const api = true;\n', 'utf8');
        await writeFile(join(outsideDir, 'secret.ts'), 'export const secret = true;\n', 'utf8');
        await symlink(outsideDir, join(repoRoot, 'src', 'outside'), 'dir');
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
            readScopedRootDir: () => repoRoot,
        });
        const temp = await fs.createTempDirectory({ prefix: 'happier-deepsec-' });

        const created = await temp.createScopedPathListFile({
            suffix: '.files.txt',
            paths: [' src/auth.ts ', './src\\api.ts', 'src/auth.ts'],
        });

        expect(created).toMatchObject({
            status: 'created',
            paths: ['src/auth.ts', 'src/api.ts'],
        });
        if (created.status !== 'created') {
            throw new Error('Expected scoped path list file to be created');
        }
        await expect(readFile(created.path, 'utf8')).resolves.toBe('src/auth.ts\nsrc/api.ts\n');

        await expect(temp.createScopedPathListFile({
            suffix: '.files.txt',
            paths: ['src/outside/secret.ts'],
        })).resolves.toEqual({
            status: 'blocked',
            diagnostics: [
                expect.objectContaining({
                    code: 'path_escape',
                    path: 'src/outside/secret.ts',
                }),
            ],
        });

        await temp.cleanup();
    });

    it('enforces declared plugin filesystem read and write permissions', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const rootDir = join(paths.storageDir, 'acme.plugin', 'fs');
        const fs = createPluginFsService({
            rootDir,
            readAllowedPaths: [],
            writeAllowedPaths: ['allowed'],
        });

        await expect(fs.writeText({ path: 'allowed/run.txt', contents: 'ok' })).resolves.toBeUndefined();
        await expect(fs.writeText({ path: 'denied/run.txt', contents: 'no' })).rejects.toThrow(/permission/);
        await expect(fs.readText({ path: 'allowed/run.txt' })).rejects.toThrow(/permission/);
    });

    it('does not expose Happier environment variables without explicit manifest scopes', () => {
        const env = createPluginEnvService({
            env: {
                HAPPIER_A13_SECRET: 'hidden',
                HAPPIER_VISIBLE_ONLY_IF_DECLARED: 'hidden',
            },
        });

        expect(env.get('HAPPIER_A13_SECRET')).toBeNull();
        expect(env.list()).toEqual({});
        expect(() => env.require('HAPPIER_A13_SECRET')).toThrow(/unavailable/);
    });

    it('exposes only explicitly declared environment variable scopes', () => {
        const env = createPluginEnvService({
            env: {
                HAPPIER_DECLARED_ENV: 'visible',
                HAPPIER_A13_SECRET: 'hidden',
            },
            allowedNames: ['HAPPIER_DECLARED_ENV'],
        });

        expect(env.get('HAPPIER_DECLARED_ENV')).toBe('visible');
        expect(env.get('HAPPIER_A13_SECRET')).toBeNull();
        expect(env.list()).toEqual({ HAPPIER_DECLARED_ENV: 'visible' });
    });

    it('threads transcript file-follow grants through the Agent transcript owner', async () => {
        const root = await makeHappyHome();
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"line":true}\n', 'utf8');
        const received: string[] = [];
        const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
        await fileFollowPathGrants.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const fileFollow = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants,
        });

        const handle = await fileFollow.follow({
            path: filePath,
            startAt: 'beginning',
            onLine: (line) => {
                received.push(line.line);
            },
        });
        await handle.close();

        expect(received).toEqual(['{"line":true}']);
    });

    it('rejects plugin-authored resolvedExecutable launches before spawning a process', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });

        await expect(exec.run({
            kind: 'resolvedExecutable',
            executablePath: shellPath,
            args: ['-c', 'exit 0'],
        } as unknown as ExecLaunchInputV1)).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
        });
    });

    it('rejects path-only executable launches before spawn even when policy contains a matching path-only scope', async () => {
        const exec = createPluginExecService({
            allowedExecutablePaths: ['git'],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: 'git',
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
        });
    });

    it('rejects Windows package-manager shims before spawn even when explicitly allowed by path', async () => {
        const npmShimPath = '/tmp/npm.cmd';
        const exec = createPluginExecService({
            allowedExecutablePaths: [npmShimPath],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: npmShimPath,
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
        });
    });

    it('denies package-manager shim system-tool paths before issuing a grant', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-shim-'));
        const npmShimPath = join(root, 'NPM.CMD');
        await writeFile(npmShimPath, '#!/bin/sh\nexit 0\n');
        await chmod(npmShimPath, 0o755);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.package-manager',
                    displayName: 'Acme Package Manager',
                    executablePath: npmShimPath,
                    lookupNames: ['npm'],
                },
            ],
        });

        await expect(exec.systemTools.resolve({
            toolId: 'acme.package-manager',
            purpose: 'verify package-manager deny before grant',
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_DENIED',
            diagnostics: [
                expect.objectContaining({
                    code: 'system_tool_denied',
                    severity: 'error',
                }),
            ],
        });
    });

    it('rejects Bun path-only runtime launches before spawn even when explicitly allowed by path', async () => {
        const bunPath = '/tmp/bun';
        const exec = createPluginExecService({
            allowedExecutablePaths: [bunPath],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: bunPath,
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
        });
    });

    it('returns structured remediation for a missing required system tool', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-missing-system-tool-'));
        const missingPath = join(root, 'missing-tool');
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.audit',
                    displayName: 'Acme Audit',
                    executablePath: missingPath,
                    source: 'system',
                },
            ],
        });
        const systemTools = exec.systemTools;

        await expect(systemTools.resolve({
            toolId: 'acme.audit',
            purpose: 'review security findings',
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_UNAVAILABLE',
            diagnostics: [
                expect.objectContaining({
                    code: 'system_tool_missing',
                    severity: 'error',
                    messageKey: 'plugins.exec.systemTools.missing',
                    detail: expect.objectContaining({
                        toolId: 'acme.audit',
                    }),
                }),
            ],
        });
    });

    it('does not grant a fallback executable when system-tool resolution is aborted after it starts', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-aborted-system-tool-'));
        const missingPreferredPath = join(root, 'missing-tool');
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.abort',
                    displayName: 'Acme Abort',
                    executablePath: shellPath,
                    source: 'system',
                },
            ],
        });
        const controller = new AbortController();
        const resolvePromise = exec.systemTools.resolve({
            toolId: 'acme.abort',
            purpose: 'verify abort fail closed',
            preferredPath: missingPreferredPath,
            signal: controller.signal,
        });

        controller.abort();

        await expect(resolvePromise).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_ABORTED',
        });
        await expect(exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf should-not-run'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
        });
    });

    it('allows ctx.exec.run with the exact launch returned by systemTools.resolve', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.echo',
                    displayName: 'Acme Echo',
                    executablePath: shellPath,
                    source: 'user_config',
                },
            ],
        });
        const systemTools = exec.systemTools;

        const grant = await systemTools.resolve({
            toolId: 'acme.echo',
            purpose: 'echo fixture text',
        });

        expect(grant).toMatchObject({
            toolId: 'acme.echo',
            source: 'user_config',
            executablePath: shellPath,
            launch: {
                kind: 'binary',
                executablePath: shellPath,
            },
        });
        await expect(exec.run({
            kind: 'binary',
            executablePath: grant.executablePath,
            args: ['-c', 'printf granted'],
        })).resolves.toMatchObject({
            stdout: 'granted',
        });
    });

    it('closes stdin for one-shot ctx.exec.run launches that do not provide input', async () => {
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });

        await expect(exec.run({
            kind: 'binary',
            executablePath: process.execPath,
            args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"));'],
        }, {
            timeoutMs: 1_000,
        })).resolves.toMatchObject({
            exitCode: 0,
            stdout: 'eof',
        });
    });

    it('resolves manifest lookup names through the host PATH without exposing PATH to child launches', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-path-'));
        const toolPath = join(root, 'acme-audit');
        await writeFile(
            toolPath,
            [
                '#!/bin/sh',
                'printf "%s" "${PATH:-}"',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(toolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-audit'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            const grant = await exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify host lookup',
            });

            expect(grant.executablePath).toBe(toolPath);
            const result = await exec.run(grant.launch);
            expect(result.stdout).not.toContain(root);
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('launches an executable JavaScript-named system tool directly through its custom shebang', async () => {
        if (process.platform === 'win32') return;

        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-node-runtime-'));
        const toolPath = join(root, 'acme-node-tool.js');
        await writeFile(
            toolPath,
            [
                '#!/bin/sh',
                'printf custom-shebang-system-tool',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(toolPath, 0o755);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.node-tool',
                    displayName: 'Acme Node Tool',
                    executablePath: toolPath,
                    source: 'system',
                },
            ],
            baseEnv: {},
        });

        const grant = await exec.systemTools.resolve({
            toolId: 'acme.node-tool',
            purpose: 'preserve executable JavaScript system-tool shebang',
        });

        expect(grant.launch).toMatchObject({
            executablePath: toolPath,
            args: [],
        });
        await expect(exec.run(grant.launch)).resolves.toMatchObject({
            exitCode: 0,
            stdout: 'custom-shebang-system-tool',
        });
    });

    it('honors a declared preferred command name through host lookup without treating it as a path', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-command-'));
        const defaultToolPath = join(root, 'acme-default');
        const overrideToolPath = join(root, 'acme-override');
        await writeFile(defaultToolPath, ['#!/bin/sh', 'printf default', ''].join('\n'), 'utf8');
        await writeFile(overrideToolPath, ['#!/bin/sh', 'printf override', ''].join('\n'), 'utf8');
        await chmod(defaultToolPath, 0o755);
        await chmod(overrideToolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-default', 'acme-override'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            const grant = await exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify command override',
                preferredCommand: 'acme-override',
            });

            expect(grant.executablePath).toBe(overrideToolPath);
            await expect(exec.run(grant.launch)).resolves.toMatchObject({
                stdout: 'override',
            });
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('prefers an explicit system-tool executable path over a matching PATH command', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-explicit-path-'));
        const pathToolDir = join(root, 'path');
        const explicitToolDir = join(root, 'explicit');
        await mkdir(pathToolDir, { recursive: true });
        await mkdir(explicitToolDir, { recursive: true });
        const pathToolPath = join(pathToolDir, 'acme-tool');
        const explicitToolPath = join(explicitToolDir, 'acme-tool');
        await writeFile(pathToolPath, ['#!/bin/sh', 'printf path', ''].join('\n'), 'utf8');
        await writeFile(explicitToolPath, ['#!/bin/sh', 'printf explicit', ''].join('\n'), 'utf8');
        await chmod(pathToolPath, 0o755);
        await chmod(explicitToolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = pathToolDir;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        executablePath: explicitToolPath,
                        lookupNames: ['acme-tool'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            const grant = await exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify explicit path precedence',
                preferredCommand: 'acme-tool',
            });

            expect(grant.executablePath).toBe(explicitToolPath);
            await expect(exec.run(grant.launch)).resolves.toMatchObject({
                stdout: 'explicit',
            });
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('rejects preferred command names that are not declared lookup names', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-command-denied-'));
        const defaultToolPath = join(root, 'acme-default');
        await writeFile(defaultToolPath, ['#!/bin/sh', 'printf default', ''].join('\n'), 'utf8');
        await chmod(defaultToolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-default'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            await expect(exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify command override rejection',
                preferredCommand: 'acme-other',
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_COMMAND',
            });
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('rejects an ungranted binary path even when a plugin guesses a valid executable', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.echo',
                    displayName: 'Acme Echo',
                    executablePath: shellPath,
                    source: 'system',
                },
            ],
        });

        await expect(exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf should-not-run'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
        });
    });

    it('sanitizes system-tool diagnostics without leaking secret environment values', async () => {
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.secret',
                    displayName: 'Acme Secret',
                    executablePath: '/tmp/missing-tool?TOKEN=super-secret',
                    source: 'user_config',
                },
            ],
        });
        const systemTools = exec.systemTools;

        await expect(systemTools.resolve({
            toolId: 'acme.secret',
            purpose: 'verify sanitizer',
        })).rejects.toMatchObject({
            diagnostics: [
                expect.objectContaining({
                    detail: expect.not.objectContaining({
                        executablePath: expect.stringContaining('super-secret'),
                    }),
                }),
            ],
        });
    });

    it('does not leak host environment variables into allowed exec launches', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const previous = process.env.HAPPIER_A13_SECRET;
        process.env.HAPPIER_A13_SECRET = 'leaked';
        try {
            const exec = createPluginExecService({
                allowedExecutablePaths: [shellPath],
                baseEnv: {},
            });

            await expect(exec.run({
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'printf "%s" "${HAPPIER_A13_SECRET:-}"'],
            })).resolves.toMatchObject({
                stdout: '',
            });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_A13_SECRET;
            } else {
                process.env.HAPPIER_A13_SECRET = previous;
            }
        }
    });

    it('disposes spawned exec handles through the plugin lifecycle registry', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const registry = createPluginDisposableRegistry();
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
            addDisposable: registry.add,
        });

        const handle = await exec.spawn({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'sleep 30'],
        });
        await registry.dispose();

        await expect(handle.exit).resolves.toMatchObject({
            exitCode: null,
        });
        await expect(handle.dispose()).resolves.toBeUndefined();
    });

    it('disposes spawned process trees instead of leaving grandchildren alive', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-exec-process-tree-'));
        const pidFile = join(root, 'grandchild.pid');
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawn({
            kind: 'binary',
            executablePath: shellPath,
            args: [
                '-c',
                [
                    `${JSON.stringify(shellPath)} -c 'trap "exit 0" TERM; while true; do sleep 1; done' &`,
                    `echo $! > ${JSON.stringify(pidFile)}`,
                    'wait',
                ].join('\n'),
            ],
        });
        try {
            await vi.waitFor(async () => {
                expect((await readFile(pidFile, 'utf8')).trim()).toMatch(/^\d+$/);
            });
            const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());

            await handle.dispose();

            await vi.waitFor(() => {
                expect(() => process.kill(grandchildPid, 0)).toThrow();
            });
        } finally {
            await handle.dispose();
        }
    });

    it('escalates process-tree disposal when a child ignores SIGTERM', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-exec-process-tree-escalate-'));
        const pidFile = join(root, 'stubborn-child.pid');
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawn({
            kind: 'binary',
            executablePath: shellPath,
            args: [
                '-c',
                [
                    `${JSON.stringify(shellPath)} -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; while true; do sleep 1; done' &`,
                    'wait',
                ].join('\n'),
            ],
        });
        let disposePromise: Promise<void> | null = null;
        try {
            await vi.waitFor(async () => {
                expect((await readFile(pidFile, 'utf8')).trim()).toMatch(/^\d+$/);
            });
            const childPid = Number((await readFile(pidFile, 'utf8')).trim());
            disposePromise = handle.dispose();

            await expect(Promise.race([
                disposePromise.then(() => 'disposed' as const),
                new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
            ])).resolves.toBe('disposed');
            await vi.waitFor(() => {
                expect(() => process.kill(childPid, 0)).toThrow();
            });
        } finally {
            if (handle.pid) {
                try {
                    process.kill(-handle.pid, 'SIGKILL');
                } catch {
                    // The shared process-tree cleanup may already have removed the process group.
                }
            }
            await disposePromise?.catch(() => undefined);
        }
    }, 10_000);

});
