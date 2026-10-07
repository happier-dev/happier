import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createPluginSecretStore,
    preparePluginSecretsDataRemoval,
} from './secrets';
import {
    createPluginStoragePublicShareSnapshot,
    createPluginStorageOwner,
    createStablePluginStorageService,
    preparePluginStorageDataRemoval,
} from './storage';
import {
    createPluginTerminalHostService,
    installAgentChildLaunchEnvironmentTransformerForTerminalHost,
} from './terminalHost';
import { createPluginTranscriptFileFollowService } from './transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './transcripts/fileFollowGrants';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';
import { PluginContextServiceError } from './errors';
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

describe('A.11 plugin context services', () => {
    it('exposes factory and service failures through the canonical public PluginError contract', async () => {
        const wrapped = new PluginContextServiceError('PLUGIN_RUNTIME_ERROR', 'opaque host failure');

        expect(wrapped).toBeInstanceOf(PluginContextServiceError);
        expect(wrapped).toBeInstanceOf(PluginError);
        expect(isPluginError(wrapped)).toBe(true);
        expect(wrapped).toMatchObject({
            name: 'PluginError',
            code: 'PLUGIN_RUNTIME_ERROR',
            message: 'opaque host failure',
            retryable: false,
        });

        const happyHomeDir = await makeHappyHome();
        const unbound = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const storageFailure = await unbound.daemonSession.listKeys().catch((error: unknown) => error);

        expect(storageFailure).toBeInstanceOf(PluginContextServiceError);
        expect(storageFailure).toBeInstanceOf(PluginError);
        expect(isPluginError(storageFailure)).toBe(true);
        expect(storageFailure).toMatchObject({
            name: 'PluginError',
            code: 'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
            retryable: false,
        });
    });

    it('scopes storage by plugin id and keeps ephemeral/daemonSession/daemon behavior distinct', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const service = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-source',
        });

        await service.ephemeral.set('volatile', { ok: true });
        await service.daemonSession.set('turn', { session: true });
        await service.daemon.set('durable', { daemon: true });

        expect(await service.ephemeral.get('volatile')).toEqual({ ok: true });
        expect(await service.daemonSession.get('turn')).toEqual({ session: true });
        expect(await service.daemon.get('durable')).toEqual({ daemon: true });

        const restarted = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-source',
        });
        expect(await restarted.ephemeral.get('volatile')).toBeNull();
        expect(await restarted.daemonSession.get('turn')).toEqual({ session: true });
        expect(await restarted.daemon.get('durable')).toEqual({ daemon: true });

        const otherSession = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-target',
        });
        expect(await otherSession.daemonSession.get('turn')).toBeNull();
        expect(await otherSession.daemon.get('durable')).toEqual({ daemon: true });

        const unbound = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
        });
        await expect(unbound.daemonSession.listKeys()).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
        });
        await expect(createPluginStoragePublicShareSnapshot({ paths })).resolves.toEqual({
            t: 'happier_plugin_public_share_storage_snapshot_v1',
            plugins: [],
        });
    });

    it('rejects unsupported JSON storage values fail-closed and hands out immutable snapshots', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const storage = createStablePluginStorageService({
            pluginId: 'acme.plugin',
            paths,
            occurrenceId: 'generation-1',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        // The public `JsonValue` surface already forbids these runtime values;
        // passing them anyway must be refused instead of silently coerced into
        // a different persisted shape the way a JSON.stringify round trip does
        // (Date -> string, NaN -> null, undefined members dropped).
        const setRaw = storage.daemon.set.bind(storage.daemon) as (
            key: string,
            value: unknown,
        ) => Promise<void>;

        await expect(setRaw('dated', { at: new Date(0) })).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_VALUE_INVALID',
        });
        await expect(setRaw('nonfinite', { ratio: Number.NaN })).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_VALUE_INVALID',
        });
        await expect(setRaw('undefined-member', { present: undefined })).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_VALUE_INVALID',
        });
        // A rejected write must not persist a silently coerced projection.
        await expect(storage.daemon.get('dated')).resolves.toBeNull();
        await expect(storage.daemon.get('nonfinite')).resolves.toBeNull();
        await expect(storage.daemon.get('undefined-member')).resolves.toBeNull();

        // Readers get immutable plain-data snapshots, so in-place edits cannot
        // masquerade as storage writes.
        await storage.daemon.set('snapshot', { nested: { ok: true } });
        const snapshot = await storage.daemon.get<Readonly<{ nested: Readonly<{ ok: boolean }> }>>('snapshot');
        expect(snapshot).toEqual({ nested: { ok: true } });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot?.nested)).toBe(true);

        // Writer isolation: mutating the source object after `set` must not
        // leak into storage.
        const source = { count: 1 };
        await storage.ephemeral.set('counter', source);
        source.count = 2;
        await expect(storage.ephemeral.get('counter')).resolves.toEqual({ count: 1 });
    });

    it('removes only one validated plugin daemon/session/filesystem and secret namespace', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const acme = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-1',
        });
        const sibling = createPluginStorageOwner({
            pluginId: 'sibling.plugin',
            paths,
            sessionId: 'session-1',
        });
        await acme.daemon.set('settings', { enabled: true });
        await acme.daemonSession.set('draft', { text: 'remove me' });
        await sibling.daemon.set('settings', { enabled: false });
        await sibling.daemonSession.set('draft', { text: 'keep me' });
        await mkdir(join(paths.storageDir, 'acme.plugin', 'fs'), { recursive: true });
        await writeFile(join(paths.storageDir, 'acme.plugin', 'fs', 'owned.txt'), 'remove me', 'utf8');

        const testSecretKey = new Uint8Array(32).fill(7);
        const acmeSecrets = createPluginSecretStore({ pluginId: 'acme.plugin', paths, secretKey: testSecretKey });
        const siblingSecrets = createPluginSecretStore({ pluginId: 'sibling.plugin', paths, secretKey: testSecretKey });
        await acmeSecrets.set('token', 'remove-me');
        await siblingSecrets.set('token', 'keep-me');

        const storageRemoval = await preparePluginStorageDataRemoval({
            pluginId: 'acme.plugin',
            paths,
        });
        const secretsRemoval = await preparePluginSecretsDataRemoval({ pluginId: 'acme.plugin', paths });
        expect(storageRemoval.hadDaemonData).toBe(true);
        await storageRemoval.removeDaemon();
        await secretsRemoval.remove();

        const restartedAcme = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-1',
        });
        expect(await restartedAcme.daemon.listKeys()).toEqual([]);
        expect(await restartedAcme.daemonSession.listKeys()).toEqual([]);
        expect(await createPluginSecretStore({ pluginId: 'acme.plugin', paths, secretKey: testSecretKey }).list()).toEqual([]);

        expect(await sibling.daemon.get('settings')).toEqual({ enabled: false });
        expect(await sibling.daemonSession.get('draft')).toEqual({ text: 'keep me' });
        expect(await siblingSecrets.get('token')).toBe('keep-me');
        await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('rejects ambiguous identities and symlinked plugin namespaces before any destructive mutation', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const removeDirectory = vi.fn(async () => undefined);

        await expect(preparePluginStorageDataRemoval({
            pluginId: '../sibling.plugin',
            paths,
            removeDirectory,
        })).rejects.toMatchObject({ code: 'PLUGIN_DATA_REMOVAL_IDENTITY_INVALID' });

        const outside = join(happyHomeDir, 'outside-plugin-data');
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8');
        await mkdir(paths.storageDir, { recursive: true });
        await symlink(outside, join(paths.storageDir, 'acme.plugin'), process.platform === 'win32' ? 'junction' : 'dir');

        await expect(preparePluginStorageDataRemoval({
            pluginId: 'acme.plugin',
            paths,
            removeDirectory,
        })).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_DATA_PATH_INVALID' });
        expect(removeDirectory).not.toHaveBeenCalled();
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
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

    it('uses caller-owned key material without creating the retired shared plugin key', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            secretKey: new Uint8Array(32).fill(7),
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });

        await secrets.set('token', 'daemon-owned-secret');

        expect(await secrets.get('token')).toBe('daemon-owned-secret');
        await expect(access(join(paths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('serializes concurrent secret writes from separate service instances without losing names', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const first = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            secretKey: new Uint8Array(32).fill(7),
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const second = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
            secretKey: new Uint8Array(32).fill(7),
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

        await storage.daemon.set('__proto__', { persisted: true });

        expect(await storage.daemon.get('__proto__')).toEqual({ persisted: true });
        expect(await storage.daemon.listKeys()).toEqual(['__proto__']);
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

    it('refuses a keyless read instead of reporting an empty namespace, whatever the name', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const secrets = createPluginSecretStore({
            pluginId: 'acme.plugin',
            paths,
        });

        // A caller with no custody-owned key material must not be able to tell
        // an empty namespace from a populated one, and must not cause any local
        // key to be created. `null` here would hide exactly that custody bug.
        // The name is irrelevant to the refusal, including a prototype-polluting
        // one whose lookup would otherwise be answered from the prototype chain.
        for (const name of ['missing', '__proto__']) {
            await expect(secrets.get(name)).rejects.toMatchObject({
                code: 'PLUGIN_SECRETS_KEY_REQUIRED',
            });
        }
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
            hasCapability: (capability) => capability === 'terminalHost',
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
        const placeholder =
            'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const transformerBinding =
            installAgentChildLaunchEnvironmentTransformerForTerminalHost(
                service,
                (environment) => Object.freeze({
                    ...environment,
                    HAPPIER_PROVIDER_KEY:
                        environment.HAPPIER_PROVIDER_KEY === placeholder
                            ? 'runner-owned-secret'
                            : environment.HAPPIER_PROVIDER_KEY,
                }),
            );

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
                    HAPPIER_PROVIDER_KEY: placeholder,
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
                HAPPIER_PROVIDER_KEY: 'runner-owned-secret',
                HAPPIER_SERVER_URL: 'https://canonical.example.test',
            },
            unsetEnvKeys: ['openai_api_key'],
            isolatedEnv: true,
        });
        expect(injectUserPrompt).toHaveBeenCalledWith(boundHandle, {
            ...prompt,
            scheduling: { timeoutMs: 15_000 },
        });
        expect(onHostCreated).toHaveBeenCalledWith(handle, 'owned');
        transformerBinding.dispose();

        await service.dispose(terminalHandle, {
            kind: 'preserve_host',
            reason: 'runtime_recovery',
        });
        expect(disposeHost).toHaveBeenCalledWith({
            handle: boundHandle,
            adapter,
            lifecycle: 'owned',
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
        const terminalOnlyCapability = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({
                command: '/usr/local/bin/claude',
                args: [],
            }),
            disposeHost: vi.fn(async () => undefined),
        });
        await expect(terminalOnlyCapability.resolve({ preference: 'auto' })).resolves.toEqual({
            status: 'resolved',
            hostKind: 'tmux',
            reason: 'tmux_available',
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
            hasCapability: (capability) => capability === 'terminalHost',
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

    it('launches an agent as a child in a borrowed Herdr terminal without creating or disposing a pane', async () => {
        const inheritedHandle: TerminalHostHandle = {
            kind: 'herdr',
            sessionName: 'default',
            paneId: 'pane-current',
            terminalId: 'terminal-current',
            socketPath: '/tmp/herdr.sock',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'shared',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const createOrAttachHost = vi.fn(async () => inheritedHandle);
        const dispose = vi.fn(async () => undefined);
        const adapter: TerminalHostAdapter = {
            kind: 'herdr',
            createOrAttachHost,
            injectUserPrompt: vi.fn(async () => ({
                status: 'injected' as const,
                injectedAt: 1,
                bytesWritten: 1,
                hostKind: 'herdr' as const,
                hostSessionName: 'default',
                paneId: 'pane-current',
            })),
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
            dispose,
        };
        let resolveExit!: (exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
        const process = {
            whenExited: new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
                resolveExit = resolve;
            }),
            terminate: vi.fn(async () => undefined),
            signal: vi.fn(async () => undefined),
        };
        const launchCurrentHostProcess = vi.fn(async () => ({ ...process, launcherIdentity: null }));
        const onHostCreated = vi.fn(async (handle: TerminalHostHandle) => ({
            ...handle,
            attachmentId: 'borrowed-attachment' as NonNullable<TerminalHostHandle['attachmentId']>,
        }));
        const disposeHost = vi.fn(async () => undefined);
        const resolveTerminalHost = vi.fn(() => ({ status: 'resolved' as const, adapter, reason: 'herdr_forced' as const }));
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost',
            resolveTerminalHost,
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: ['--model', 'sonnet'] }),
            resolveCurrentHost: () => ({ handle: inheritedHandle, lifecycle: 'borrowed' }),
            launchCurrentHostProcess,
            onHostCreated,
            disposeHost,
        });

        const handle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli', agentId: 'claude', args: ['--continue'], env: { EXTRA: '1' } },
            isolatedEnv: true,
        });

        expect(createOrAttachHost).not.toHaveBeenCalled();
        expect(resolveTerminalHost).toHaveBeenCalledWith('herdr');
        expect(launchCurrentHostProcess).toHaveBeenCalledWith(expect.objectContaining({
            spawnArgv: ['/usr/local/bin/claude', '--model', 'sonnet', '--continue'],
            workingDirectory: '/workspace',
            spawnEnv: expect.objectContaining({ EXTRA: '1' }),
        }));
        expect(onHostCreated).toHaveBeenCalledWith(inheritedHandle, 'borrowed');
        await expect(service.evaluateLiveness(handle)).resolves.toMatchObject({ paneAlive: true });

        resolveExit({ code: 0, signal: null });
        await Promise.resolve();
        await expect(service.evaluateLiveness(handle)).resolves.toMatchObject({ paneAlive: false, paneDead: true });

        await service.dispose(handle, { kind: 'preserve_host', reason: 'runtime_recovery' });
        expect(process.terminate).toHaveBeenCalledOnce();
        expect(disposeHost).toHaveBeenCalledWith({
            handle,
            adapter,
            intent: { kind: 'preserve_host', reason: 'runtime_recovery' },
            lifecycle: 'borrowed',
        });
        expect(dispose).not.toHaveBeenCalled();
    });

    it('stops a direct provider child before disposing an owned current terminal host', async () => {
        const inheritedHandle: TerminalHostHandle = {
            kind: 'herdr',
            sessionName: 'default',
            paneId: 'pane-owned',
            terminalId: 'terminal-owned',
            socketPath: '/tmp/herdr.sock',
            attachMetadata: {
                attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine',
                maxClients: null, requiresLocalAttachmentInfo: true, liveProbe: 'required',
            },
        };
        const adapter: TerminalHostAdapter = {
            kind: 'herdr',
            createOrAttachHost: vi.fn(async () => inheritedHandle),
            injectUserPrompt: vi.fn(async () => ({
                status: 'injected' as const, injectedAt: 1, bytesWritten: 1,
                hostKind: 'herdr' as const, hostSessionName: 'default', paneId: 'pane-owned',
            })),
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
            dispose: vi.fn(async () => undefined),
        };
        const process = {
            whenExited: new Promise<never>(() => undefined),
            launcherIdentity: null,
            terminate: vi.fn(async () => undefined),
            signal: vi.fn(async () => undefined),
        };
        const disposeHost = vi.fn(async () => undefined);
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'herdr_forced' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
            resolveCurrentHost: () => ({ handle: inheritedHandle, lifecycle: 'owned' }),
            launchCurrentHostProcess: vi.fn(async () => process),
            disposeHost,
        });

        const handle = await service.createOrAttachHost({
            preference: 'herdr',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli', agentId: 'claude' },
            isolatedEnv: true,
        });
        await service.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });

        expect(process.terminate).toHaveBeenCalledOnce();
        expect(disposeHost).toHaveBeenCalledWith({
            handle, adapter,
            intent: { kind: 'destroy_owned_host', reason: 'session_closed' },
            lifecycle: 'owned',
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
            hasCapability: (capability) => capability === 'terminalHost',
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
            hasCapability: (capability) => capability === 'terminalHost',
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
            hasCapability: (capability) => capability === 'terminalHost',
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

    it('threads transcript file-follow grants through the Agent transcript owner', async () => {
        const root = await makeHappyHome();
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"line":true}\n', 'utf8');
        const received: string[] = [];
        const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
        await fileFollowPathGrants.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            scope: { kind: 'session', sessionId: 'session-1' },
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

});
