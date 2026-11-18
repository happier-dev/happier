import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    query,
    type ClaudeSdkQueryContext,
    type ClaudeSdkExecClientHandle,
    type ClaudeSdkJsonStreamClient,
} from './query.js';
import type { SDKMessage } from './types.js';

function createJsonStreamHandle() {
    const listeners = new Set<(record: unknown) => void | Promise<void>>();
    const written: unknown[] = [];
    let resolveExit: ((result: Readonly<{
        exitCode: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
    }>) => void) | null = null;
    const exit = new Promise<Readonly<{
        exitCode: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
    }>>((resolve) => {
        resolveExit = resolve;
    });
    const client: ClaudeSdkJsonStreamClient = {
        closed: new Promise(() => undefined),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async writeRecord(record) {
            written.push(record);
            return { kind: 'written' };
        },
    };
    const handle: ClaudeSdkExecClientHandle = {
        client,
        process: {
            exit,
            async writeStdin() {},
            kill() {},
            async dispose() {},
        },
        status: 'running',
        onExit() {
            return () => undefined;
        },
        async dispose() {},
    };
    return {
        handle,
        written,
        async emit(record: unknown) {
            await Promise.all([...listeners].map((listener) => listener(record)));
        },
        async exitWith(result: Readonly<{
            exitCode: number | null;
            signal: string | null;
            stdout?: string;
            stderr?: string;
        }>) {
            resolveExit?.({
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
            });
            await exit;
        },
    };
}

function createContextFixture(stream = createJsonStreamHandle()) {
    const spawnClient = vi.fn<ClaudeSdkQueryContext['spawnClient']>(async () => stream.handle);
    const ctx = {
        agentRuntime: {
            exec: {
                spawnClient,
            },
        },
    } satisfies Parameters<typeof query>[0];
    return { ctx, spawnClient, stream };
}

async function* prompt() {
    yield {
        type: 'user',
        message: { role: 'user', content: 'hello' },
    } satisfies SDKMessage;
}

/** The merged `--settings` Claude receives: SDK launches pass it through a private file. */
const readSettingsArg = (args: readonly string[]): unknown => JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] ?? '', 'utf8'));

describe('Claude plugin SDK query', () => {
    it('accepts the exact native started receipt before generation or a replayed user message', async () => {
        const { ctx, stream } = createContextFixture();
        const running = query(ctx, { prompt: prompt() });
        let settled = false;
        void running.promptTransportOutcome.then(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({ type: 'user' })));
            const submitted = stream.written.find((record): record is { type: 'user'; uuid: string } =>
                !!record && typeof record === 'object' && 'type' in record && record.type === 'user' && 'uuid' in record && typeof record.uuid === 'string');
            expect(submitted).toBeDefined();
            const receipt = { type: 'command_lifecycle', command_uuid: submitted!.uuid, session_id: 'native-1' };
            await stream.emit({ ...receipt, state: 'queued' });
            await stream.emit({ ...receipt, state: 'started', command_uuid: 'another-input' });
            await stream.emit({ ...receipt, state: 'started', isSynthetic: true });
            await stream.emit({ ...receipt, state: 'started', parent_tool_use_id: 'child-tool' });
            expect(settled).toBe(false);
            await stream.emit({ ...receipt, state: 'started' });
            await vi.waitFor(() => expect(settled).toBe(true));
            await expect(running.promptTransportOutcome).resolves.toEqual({ kind: 'accepted' });
            const followUpUuid = 'follow-up-input';
            let followUpSettled = false;
            const followUp = running.sendUserMessage('follow up', followUpUuid);
            void followUp.then(() => { followUpSettled = true; });
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({ type: 'user', uuid: followUpUuid })));
            await stream.emit({ ...receipt, state: 'started' });
            await stream.emit({ ...receipt, state: 'queued', command_uuid: followUpUuid });
            expect(followUpSettled).toBe(false);
            await stream.emit({ ...receipt, state: 'started', command_uuid: followUpUuid });
            await expect(followUp).resolves.toEqual({ kind: 'accepted' });
        } finally { await running.dispose(); }
    });

    it('blocks native generation and fails the query when pre-generation publication fails', async () => {
        const { ctx, stream } = createContextFixture();
        const failure = Object.assign(new Error('private Home endpoint and credential fixture'), { code: 'provider_operation_not_current' });
        const running = query(ctx, { prompt: prompt(), options: { onSessionHook: async () => {}, beforePromptGeneration: async () => { throw failure; } } });
        try {
            await vi.waitFor(() => expect(stream.written[0]).toMatchObject({ type: 'control_request' }));
            const initialization = stream.written[0] as { request_id: string };
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: initialization.request_id, response: {} } });
            await stream.emit({ type: 'control_request', request_id: 'pre-generation', request: { subtype: 'hook_callback', callback_id: 'happier-session-hook', input: { hook_event_name: 'UserPromptSubmit', session_id: 'native' } } });
            await vi.waitFor(() => expect(stream.written).toContainEqual({ type: 'control_response', response: {
                subtype: 'success', request_id: 'pre-generation', response: { continue: false, stopReason: 'Happier could not publish the accepted Turn.' },
            } }));
            expect(JSON.stringify(stream.written)).not.toContain('private Home');
            await expect(running.next()).rejects.toBe(failure);
        } finally { await running.dispose(); }
    });

    it('initializes hooks before input and delivers callbacks', async () => {
        const { ctx, stream, spawnClient } = createContextFixture();
        const observed: unknown[] = [];
        const running = query(ctx, { prompt: prompt(), options: {
            onSessionHook: async (input) => { observed.push(input); },
        } });
        try {
            await vi.waitFor(() => expect(stream.written[0]).toMatchObject({
                type: 'control_request', request: { subtype: 'initialize', hooks: {
                    UserPromptSubmit: [{ hookCallbackIds: ['happier-session-hook'] }],
                    PostToolUse: [{ hookCallbackIds: ['happier-session-hook'] }],
                } },
            }));
            expect(stream.written).toHaveLength(1);
            const initialization = stream.written[0] as { request_id: string };
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: initialization.request_id, response: {} } });
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({ type: 'user' })));
            const submitted = stream.written.find((record): record is { type: 'user'; uuid: string } =>
                !!record && typeof record === 'object' && 'type' in record && record.type === 'user' && 'uuid' in record && typeof record.uuid === 'string');
            expect(submitted).toBeDefined();
            await stream.emit({ ...submitted, message: { role: 'user', content: 'private prompt fixture' } });
            await expect(running.promptTransportOutcome).resolves.toEqual({ kind: 'accepted' });
            const input = { hook_event_name: 'PostToolUse', session_id: 'native-1', tool_name: 'Agent', tool_response: { status: 'async_launched', agentId: 'child-1' } };
            await stream.emit({ type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback', callback_id: 'happier-session-hook', tool_use_id: 'exact-native-tool', input } });
            await vi.waitFor(() => expect(stream.written).toContainEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'hook-1', response: {} } }));
            expect(observed).toEqual([{ ...input, tool_use_id: 'exact-native-tool' }]);
            expect(spawnClient).toHaveBeenCalledOnce();
        } finally { await running.dispose(); }
    });

    it('cancels an in-process hook without writing a late callback response', async () => {
        const { ctx, stream } = createContextFixture();
        let hookSignal: AbortSignal | undefined;
        let hookCompleted = false;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const running = query(ctx, { prompt: prompt(), options: { onSessionHook: async (_input, { signal }) => { hookSignal = signal; await held; hookCompleted = true; } } });
        try {
            await vi.waitFor(() => expect(stream.written[0]).toMatchObject({ type: 'control_request' }));
            const initialization = stream.written[0] as { request_id: string };
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: initialization.request_id, response: {} } });
            await stream.emit({ type: 'control_request', request_id: 'cancel-hook', request: { subtype: 'hook_callback', callback_id: 'happier-session-hook', input: { hook_event_name: 'SessionStart', session_id: 'native' } } });
            await vi.waitFor(() => expect(hookSignal).toBeDefined());
            await stream.emit({ type: 'control_cancel_request', request_id: 'cancel-hook' });
            expect(hookSignal?.aborted).toBe(true);
            release();
            await vi.waitFor(() => expect(hookCompleted).toBe(true));
            expect(stream.written).not.toContainEqual(expect.objectContaining({ response: expect.objectContaining({ request_id: 'cancel-hook' }) }));
        } finally { release(); await running.dispose(); }
    });

    it('settles unsupported hook initialization before any prompt and disposes the owned child', async () => {
        const { ctx, stream } = createContextFixture();
        const dispose = vi.spyOn(stream.handle, 'dispose');
        const running = query(ctx, { prompt: prompt(), options: { onSessionHook: async () => {} } });
        try {
            await vi.waitFor(() => expect(stream.written[0]).toMatchObject({ type: 'control_request' }));
            const initialization = stream.written[0] as { request_id: string };
            await stream.emit({ type: 'control_response', response: { subtype: 'error', request_id: initialization.request_id, error: 'Unsupported initialize' } });
            await expect(running.next()).rejects.toThrow('Unsupported initialize');
            expect(stream.written).not.toContainEqual(expect.objectContaining({ type: 'user' }));
        } finally { await running.dispose(); }
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('interrupts and disposes a child whose hook initialization is still pending', async () => {
        const { ctx, stream } = createContextFixture();
        const dispose = vi.spyOn(stream.handle, 'dispose');
        const running = query(ctx, { prompt: prompt(), options: { onSessionHook: async () => {} } });
        await vi.waitFor(() => expect(stream.written[0]).toMatchObject({ type: 'control_request' }));
        await running.interrupt();
        expect(stream.written).toContainEqual({ type: 'control_request', request: { subtype: 'interrupt' } });
        await running.dispose();
        expect(dispose).toHaveBeenCalledOnce();
        expect(stream.written).not.toContainEqual(expect.objectContaining({ type: 'user' }));
    });

    it('does not copy private observation errors into native hook responses or the transcript stream', async () => {
        const { ctx, stream } = createContextFixture();
        const onMessageReceived = vi.fn();
        const running = query(ctx, { prompt: prompt(), onMessageReceived, options: {
            onSessionHook: async () => { throw new Error('synthetic-private-hook-error'); },
        } });
        try {
            await vi.waitFor(() => expect(stream.written[0]).toMatchObject({ type: 'control_request' }));
            const initialization = stream.written[0] as { request_id: string };
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: initialization.request_id, response: {} } });
            await stream.emit({ type: 'control_request', request_id: 'failed-hook', request: {
                subtype: 'hook_callback', callback_id: 'happier-session-hook', input: { hook_event_name: 'PostToolUse', session_id: 'native' },
            } });
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({ response: expect.objectContaining({ request_id: 'failed-hook', subtype: 'error' }) })));
            expect(JSON.stringify(stream.written)).not.toContain('synthetic-private-hook-error');
            expect(onMessageReceived).not.toHaveBeenCalled();
        } finally { await running.dispose(); }
    });

    it('delivers skills beside other plugins once and merges path-local native overrides', async () => {
        const { ctx, spawnClient } = createContextFixture();
        const running = query(ctx, { prompt: prompt(), options: {
            skills: { pluginRoot: '/session/happier', skillsRoot: '/session/happier/skills', items: [],
                nativeDisables: [{ name: 'blocked', path: '/native/blocked/SKILL.md' }] },
            plugins: [{ type: 'local', path: '/session/hooks' }],
            extraArgs: ['--plugin-dir', '/session/hooks'],
            settingsJson: JSON.stringify({ skillOverrides: { retained: 'on' } }),
        } });
        const args = spawnClient.mock.calls[0]?.[0].launch.args ?? [];
        expect(args.filter(arg => arg === '/session/happier')).toHaveLength(1);
        expect(args.filter(arg => arg === '/session/hooks')).toHaveLength(1);
        expect(readSettingsArg(args)).toMatchObject({ skillOverrides: { retained: 'on', blocked: 'off' } });
        await running.dispose();
    });

    it('acknowledges reload only after both control success and commands_changed', async () => {
        const { ctx, stream } = createContextFixture();
        const running = query(ctx, { prompt: prompt() });
        let settled = false;
        const reload = running.reloadSkills().then(() => { settled = true; });
        await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({
            type: 'control_request', request: { subtype: 'reload_skills' },
        })));
        const request = stream.written.find((record): record is { request_id: string; request: { subtype: string } } =>
            Boolean(record && typeof record === 'object' && 'request' in record
                && (record.request as { subtype?: string }).subtype === 'reload_skills'))!;
        await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
        await Promise.resolve();
        expect(settled).toBe(false);
        await stream.emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['happier:contract-skill'] });
        await reload;
        expect(settled).toBe(true);
        await running.dispose();
    });

    it('does not acknowledge a repeated reload from the previous commands_changed or before control success', async () => {
        const { ctx, stream } = createContextFixture();
        const running = query(ctx, { prompt: prompt() });
        const nextRequest = async (count: number) => {
            await vi.waitFor(() => expect(stream.written.filter(record => record && typeof record === 'object'
                && 'type' in record && record.type === 'control_request')).toHaveLength(count));
            const request = stream.written.filter((record): record is { request_id: string } =>
                Boolean(record && typeof record === 'object' && 'type' in record && record.type === 'control_request'
                    && 'request_id' in record && typeof record.request_id === 'string')).at(-1)!;
            return request.request_id;
        };
        try {
            const first = running.reloadSkills();
            const firstId = await nextRequest(1);
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: firstId, response: {} } });
            await stream.emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['happier:first'] });
            await first;
            let settled = false;
            const second = running.reloadSkills().then(() => { settled = true; });
            const secondId = await nextRequest(2);
            await Promise.resolve();
            expect(settled).toBe(false);
            await stream.emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['happier:second'] });
            await Promise.resolve();
            expect(settled).toBe(false);
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: secondId, response: {} } });
            await second;
        } finally { await running.dispose(); }
    });

    it('rejects cancellation while commands_changed is pending and accepts a subsequent reload', async () => {
        const { ctx, stream } = createContextFixture();
        const running = query(ctx, { prompt: prompt() });
        const abort = new AbortController();
        try {
            const cancelled = running.reloadSkills({ signal: abort.signal });
            const rejection = expect(cancelled).rejects.toThrow('cancel reload');
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({
                type: 'control_request', request: { subtype: 'reload_skills' },
            })));
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'claude-sdk-control-1', response: {} } });
            abort.abort(new Error('cancel reload'));
            await rejection;
            const retry = running.reloadSkills();
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({ request_id: 'claude-sdk-control-2' })));
            await stream.emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['happier:retry'] });
            await stream.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'claude-sdk-control-2', response: {} } });
            await retry;
        } finally { await running.dispose(); }
    });
    it.each([true, false])('retains permission callback ownership without replacing standalone custom prompt tools (host callback=%s)', async hostCallback => {
        const { ctx, spawnClient } = createContextFixture();
        const running = query(ctx, { prompt: prompt(), options: {
            permissionPromptToolName: 'mcp__external__approve',
            ...(hostCallback ? { canCallTool: async () => ({ behavior: 'deny' as const, message: 'Denied' }) } : {}),
        } });
        try {
            const args = spawnClient.mock.calls[0]?.[0].launch.args ?? [];
            expect(args.filter(arg => arg === '--permission-prompt-tool')).toHaveLength(1);
            expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe(hostCallback ? 'stdio' : 'mcp__external__approve');
        } finally { await running.dispose(); }
    });

    it('removes every built-in tool for an empty confined list despite broader native options', async () => {
        const { ctx, spawnClient } = createContextFixture();
        const running = query(ctx, {
            prompt: prompt(),
            options: {
                allowedTools: [], unlistedTools: 'deny', tools: ['default'],
                allowDangerouslySkipPermissions: true, permissionMode: 'bypassPermissions',
                extraArgs: ['--allowed-tools', 'Read', '--permission-mode=bypassPermissions'],
            },
        });
        const args = spawnClient.mock.calls[0]?.[0].launch.args ?? [];
        expect(args.filter(arg => arg === '--tools')).toHaveLength(1);
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args.filter(arg => arg === '--permission-mode')).toHaveLength(1);
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
        expect(args).not.toContain('--allow-dangerously-skip-permissions');
        expect(args).not.toContain('--allowed-tools');
        expect(args).not.toContain('--permission-mode=bypassPermissions');
        expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
        expect(readSettingsArg(args)).toMatchObject({ permissions: {
            allow: [], defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable',
        } });
        await running.dispose();
    });

    it('uses a private prompt file for a supported native plan, preserving text beyond Windows argv limits and cleaning it after disposal', async () => {
        const { ctx, spawnClient } = createContextFixture();
        const text = `ROLE\n${'雪 " $ \\'.repeat(8_000)}`;
        const running = query(ctx, {
            prompt: prompt(),
            options: { appendSystemPrompt: text, appendSystemPromptFile: true },
        });
        await vi.waitFor(() => expect(spawnClient).toHaveBeenCalledOnce());
        const args = spawnClient.mock.calls[0]?.[0].launch.args ?? [];
        expect(args).not.toContain(text);
        expect(args).not.toContain('--append-system-prompt');
        const path = args[args.indexOf('--append-system-prompt-file') + 1];
        expect(await readFile(path, 'utf8')).toBe(text);
        if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
        await running.dispose();
        await running.dispose();
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('spawns Claude through ctx.agentRuntime.exec json-stream instead of opening a process locally', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'sonnet',
                permissionMode: 'acceptEdits',
            },
        });

        expect(spawnClient).toHaveBeenCalledWith(expect.objectContaining({
            launch: expect.objectContaining({
                kind: 'agent-cli',
                agentId: 'claude',
                cwd: '/tmp/project',
            }),
            transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
            protocol: { kind: 'json-stream' },
        }), expect.anything());
        expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
            '--output-format',
            'stream-json',
            '--input-format',
            'stream-json',
            '--model',
            'sonnet',
            '--permission-mode',
            'acceptEdits',
        ]));
    });

    it('omits --permission-mode for default so Claude can honor permissions.defaultMode from settings', () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                permissionMode: 'default',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).not.toContain('--permission-mode');
    });

    it('emits the --effort flag for the reasoning effort query option', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-opus-4-8',
                effort: 'xhigh',
            },
        });

        expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
            '--effort',
            'xhigh',
        ]));
    });

    it.each([false, true])('merges one inline settings overlay for native and pool SDK queries (pool=%s)', async (pool) => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-opus-4-8',
                settingsJson: '{"ultracode":true}',
                ...(pool ? { env: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                    kind: 'group', serviceId: 'happier.agent.claude/claude-subscription', groupId: 'pool',
                    activeProfileId: 'first', fallbackProfileId: 'first', generation: 1,
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', policy: {},
                }]) } } : {}),
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        const settings = readSettingsArg(args) as Record<string, unknown>;
        expect(settings.ultracode).toBe(true);
        if (pool) expect(settings.autoContinueAtUsageLimit).toBe(false);
        else expect(settings).not.toHaveProperty('autoContinueAtUsageLimit');
        expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    });

    it.each([false, true])('materializes inline MCP JSON and preserves the native exit despite incomplete exact cleanup (incomplete=%s)', async (incomplete) => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const inlineConfig = JSON.stringify({
            mcpServers: {
                fixture: {
                    type: 'stdio',
                    command: 'synthetic-mcp-command',
                    env: { TOKEN: 'synthetic-mcp-credential-marker' },
                },
            },
        });
        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                extraArgs: ['--mcp-config', inlineConfig],
            },
        });
        await spawnClient.mock.results[0]?.value;

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(JSON.stringify(args)).not.toContain('synthetic-mcp-credential-marker');
        const flagIndex = args.indexOf('--mcp-config');
        expect(flagIndex).toBeGreaterThanOrEqual(0);
        const configPath = args[flagIndex + 1]!;
        expect(configPath).not.toBe(inlineConfig);
        await expect(readFile(configPath, 'utf8')).resolves.toBe(inlineConfig);
        if (process.platform !== 'win32') {
            expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        }

        const unexpected = join(dirname(configPath), 'unexpected');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            if (incomplete) await writeFile(unexpected, 'retained');
            const completion = sdkQuery.next();
            await stream.exitWith({ exitCode: 0, signal: null });
            await expect(completion).resolves.toEqual({ done: true, value: undefined });
            await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
            if (incomplete) {
                await expect(readFile(unexpected, 'utf8')).resolves.toBe('retained');
                expect(warning).toHaveBeenCalledWith(expect.stringContaining('claude_mcp_cleanup_incomplete'));
            }
        } finally {
            warning.mockRestore();
            await unlink(unexpected).catch(() => undefined);
            await rmdir(dirname(configPath)).catch(() => undefined);
        }
    });

    // Merged hook and permission settings measured 30,091 characters with 1,470 quotes on a native
    // Windows Agent SDK turn: inline, the spawn failed with ENAMETOOLONG (32,767-character limit).
    it('passes the merged launch settings through a private file removed at exit', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: { settingsJson: JSON.stringify({ ultracode: true }) },
        });
        await spawnClient.mock.results[0]?.value;

        const launch = spawnClient.mock.calls[0]?.[0].launch;
        const args = launch?.args as string[];
        expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
        const settingsPath = args[args.indexOf('--settings') + 1]!;
        expect(settingsPath.trim().startsWith('{')).toBe(false);
        expect(launch?.requiredFiles).toContain(settingsPath);
        expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ ultracode: true });

        const completion = sdkQuery.next();
        await stream.exitWith({ exitCode: 0, signal: null });
        await expect(completion).resolves.toEqual({ done: true, value: undefined });
        await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await rmdir(dirname(settingsPath)).catch(() => undefined);
    });

    it('removes a materialized MCP config when the query is disposed before process exit', async () => {
        const { ctx, spawnClient } = createContextFixture();
        const inlineConfig = JSON.stringify({
            mcpServers: { fixture: { command: 'mcp-server', env: { TOKEN: 'synthetic-dispose-marker' } } },
        });
        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: { extraArgs: [`--mcp-config=${inlineConfig}`] },
        });
        await spawnClient.mock.results[0]?.value;
        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(JSON.stringify(args)).not.toContain('synthetic-dispose-marker');
        const configArg = args.find((arg) => arg.startsWith('--mcp-config='))!;
        const configPath = configArg.slice('--mcp-config='.length);
        await expect(readFile(configPath, 'utf8')).resolves.toBe(inlineConfig);

        await sdkQuery.dispose();

        await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('maps the released advanced Agent SDK options to the native Claude launch without control-plane overrides', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                customSystemPrompt: 'canonical prompt replaced by the released advanced override',
                settingsJson: '{"ultracode":true}',
                plugins: [{ type: 'local', path: '/tmp/plugin' }],
                betas: ['beta-a', 'beta-b', '--permission-mode', 'bypassPermissions'],
                maxBudgetUsd: 3.5,
                sandbox: { enabled: true },
                additionalDirectories: ['/tmp/extra', 'C:\\projects\\two words', '--permission-prompt-tool', 'mcp__external__approve'],
                permissionMode: 'plan',
                canCallTool: async () => ({ behavior: 'deny', message: 'Denied' }),
                permissionPromptToolName: 'stdio',
                tools: ['Read', 'Edit'],
                systemPrompt: 'Be concise',
                debug: true,
                debugFile: '/tmp/claude-debug.log',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining([
            '--plugin-dir', '/tmp/plugin',
            '--betas=beta-a', '--betas=beta-b', '--betas=--permission-mode', '--betas=bypassPermissions',
            '--max-budget-usd', '3.5',
            '--add-dir=/tmp/extra', '--add-dir=C:\\projects\\two words', '--add-dir=--permission-prompt-tool', '--add-dir=mcp__external__approve',
            '--permission-prompt-tool', 'stdio',
            '--tools', 'Read,Edit',
            '--system-prompt', 'Be concise',
            '--debug',
            '--debug-file', '/tmp/claude-debug.log',
        ]));
        expect(args.filter(arg => arg === '--permission-mode')).toHaveLength(1);
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
        expect(args.filter(arg => arg === '--permission-prompt-tool')).toHaveLength(1);
        expect(args.indexOf('--settings')).toBeGreaterThanOrEqual(0);
        expect(readSettingsArg(args)).toEqual({
            ultracode: true,
            sandbox: { enabled: true },
        });
        expect(args).not.toContain('canonical prompt replaced by the released advanced override');
    });

    it('lets an explicit settingsPath win over settingsJson (one --settings only)', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-sdk-explicit-settings-'));
        const settingsPath = join(root, 'settings.json');
        await writeFile(settingsPath, JSON.stringify({ theme: 'light' }));
        const { ctx, spawnClient } = createContextFixture();
        const running = query(ctx, {
            prompt: prompt(),
            options: { cwd: root, settingsPath, settingsJson: '{"ultracode":true}' },
        });
        try {
            const args = spawnClient.mock.calls[0]?.[0].launch.args ?? [];
            expect(args).toEqual(expect.arrayContaining(['--settings', settingsPath]));
            expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
            expect(args).not.toContain('{"ultracode":true}');
        } finally {
            await running.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('passes a [1m] extended-context model id through --model unmutated', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-sonnet-4-6[1m]',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4-6[1m]']));
    });

    it('answers Claude can_use_tool control requests through the configured permission callback', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const canCallTool = vi.fn(async () => ({
            behavior: 'allow' as const,
            updatedInput: { path: 'README.md' },
        }));

        query(ctx, {
            prompt: prompt(),
            options: {
                canCallTool,
            },
        });
        await spawnClient.mock.results[0]?.value;

        await stream.emit({
            type: 'control_request',
            request_id: 'req-1',
            request: {
                subtype: 'can_use_tool',
                tool_name: 'Read',
                input: { path: 'README.md' },
            },
        });

        expect(canCallTool).toHaveBeenCalledWith('Read', { path: 'README.md' }, expect.objectContaining({
            requestId: 'req-1',
            signal: expect.any(AbortSignal),
        }));
        expect(stream.written).toContainEqual({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'req-1',
                response: {
                    behavior: 'allow',
                    updatedInput: { path: 'README.md' },
                },
            },
        });
    });

    it('answers Claude oauth_token_refresh control requests through the configured OAuth callback', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const getOAuthToken = vi.fn(async () => 'fresh-access-token');

        query(ctx, {
            prompt: prompt(),
            options: {
                env: { EXISTING_ENV: 'kept' },
                getOAuthToken,
            },
        });
        await spawnClient.mock.results[0]?.value;

        expect(spawnClient.mock.calls[0]?.[0].launch.env).toEqual({
            EXISTING_ENV: 'kept',
            CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        });

        await stream.emit({
            type: 'control_request',
            request_id: 'oauth-1',
            request: {
                subtype: 'oauth_token_refresh',
            },
        });

        expect(getOAuthToken).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
        expect(stream.written).toContainEqual({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'oauth-1',
                response: {
                    accessToken: 'fresh-access-token',
                },
            },
        });
    });

    it('acknowledges live permission controls and rejects provider failure or disposal', async () => {
        const { ctx, stream } = createContextFixture();
        const sdkQuery = query(ctx, { prompt: prompt() });
        const requestFor = async (mode: string) => {
            await vi.waitFor(() => expect(stream.written).toContainEqual(expect.objectContaining({
                type: 'control_request', request_id: expect.any(String),
                request: { subtype: 'set_permission_mode', mode },
            })));
            const record = stream.written.find(value => {
                const request = (value as { request?: { subtype?: string; mode?: string } }).request;
                return request?.subtype === 'set_permission_mode' && request.mode === mode;
            }) as { request_id: string };
            return record.request_id;
        };
        try {
            let acknowledged = false;
            const bypass = sdkQuery.setPermissionMode('bypassPermissions').then(() => { acknowledged = true; });
            const bypassRequestId = await requestFor('bypassPermissions');
            expect(acknowledged).toBe(false);
            await stream.emit({ type: 'control_response', response: {
                subtype: 'success', request_id: bypassRequestId, response: {},
            } });
            await bypass;
            expect(acknowledged).toBe(true);

            const restore = sdkQuery.setPermissionMode('default');
            const restored = expect(restore).rejects.toThrow('permission change refused');
            const restoreRequestId = await requestFor('default');
            await stream.emit({ type: 'control_response', response: {
                subtype: 'error', request_id: restoreRequestId, error: 'permission change refused',
            } });
            await restored;

            const pending = sdkQuery.setPermissionMode('acceptEdits');
            const cancelled = expect(pending).rejects.toThrow('disposed before control response');
            await requestFor('acceptEdits');
            await sdkQuery.dispose();
            await cancelled;
            expect(stream.written.filter(value => (value as { type?: string }).type === 'user')).toHaveLength(1);
        } finally {
            await sdkQuery.dispose();
        }
    });

    it('requests and resolves Claude live context usage through the SDK control channel', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const sdkQuery = query(ctx, { prompt: prompt() });
        await spawnClient.mock.results[0]?.value;

        const responsePromise = sdkQuery.getContextUsage();
        await vi.waitFor(() => {
            expect(stream.written).toContainEqual(expect.objectContaining({
                type: 'control_request',
                request_id: expect.any(String),
                request: { subtype: 'get_context_usage' },
            }));
        });
        const request = stream.written.find((record) =>
            (record as { request?: { subtype?: string } }).request?.subtype === 'get_context_usage') as {
                request_id: string;
            };
        const response = {
            totalTokens: 48_000,
            maxTokens: 200_000,
            model: 'claude-sonnet-4-6',
            isAutoCompactEnabled: true,
            categories: [{ name: 'Messages', tokens: 30_000, color: 'blue' }],
        };

        await stream.emit({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request.request_id,
                response,
            },
        });

        await expect(responsePromise).resolves.toEqual(response);
    });

    it.each([false, true])('preserves spawn failure cause and observable exact MCP cleanup (incomplete=%s)', async (incomplete) => {
        const failureCause = { code: 'provider_endpoint_unavailable', phase: 'client_start', failureReason: 'permission_denied', httpStatus: 503 } as const;
        const failure = Object.assign(new Error('spawn failed'), { failureCause });
        let configPath: string | undefined;
        const ctx = {
            agentRuntime: {
                exec: {
                    spawnClient: vi.fn(async (spec) => {
                        const args = spec.launch.args ?? [];
                        configPath = args[args.indexOf('--mcp-config') + 1];
                        if (incomplete && configPath) await writeFile(join(dirname(configPath), 'unexpected'), 'retained');
                        throw failure;
                    }),
                },
            },
        } satisfies Parameters<typeof query>[0];

        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                extraArgs: ['--mcp-config', JSON.stringify({
                    mcpServers: {
                        fixture: { command: 'mcp-server', env: { TOKEN: 'synthetic-spawn-failure-marker' } },
                    },
                })],
            },
        });

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            if (incomplete) {
                await expect(sdkQuery.next()).rejects.toMatchObject({ cause: failure, failureCause, errors: [failure, expect.any(Error)] });
                expect(warning).toHaveBeenCalledWith(expect.stringContaining('claude_mcp_cleanup_incomplete'));
                await expect(readFile(join(dirname(configPath!), 'unexpected'), 'utf8')).resolves.toBe('retained');
            } else await expect(sdkQuery.next()).rejects.toBe(failure);
            expect(configPath).toBeTruthy();
            await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            warning.mockRestore();
            if (configPath) {
                await unlink(join(dirname(configPath), 'unexpected')).catch(() => undefined);
                await rmdir(dirname(configPath)).catch(() => undefined);
            }
        }
    });

    it('propagates failed Claude process exits with stderr to the SDK message iterator', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();

        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
            },
        });
        await spawnClient.mock.results[0]?.value;

        const nextMessage = sdkQuery.next();
        await stream.exitWith({
            exitCode: 1,
            signal: null,
            stderr: 'Claude Code login expired',
        });

        await expect(nextMessage).rejects.toThrow('Claude Code login expired');
    });

    it.each([
        'You cannot use --strict-mcp-config when an enterprise MCP config is present',
        'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
    ])('classifies the native managed MCP startup refusal: %s', async stderr => {
        const { ctx, stream } = createContextFixture();
        const running = query(ctx, { prompt: prompt(), options: { strictMcpConfig: true } });
        const rejection = expect(running.next()).rejects.toMatchObject({
            code: 'claude_managed_mcp_policy_conflict', retryable: false,
        });
        await stream.exitWith({ exitCode: 1, signal: null, stderr });
        await rejection;
        await running.dispose();
    });
});
