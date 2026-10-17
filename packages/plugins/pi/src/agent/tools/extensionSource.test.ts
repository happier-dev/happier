import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildPiHappierToolsExtensionSource,
  PI_HAPPIER_TOOLS_CONFIG_FLAG,
} from './extensionSource.js';
import { preparePiHappierToolsExtension } from './assets.js';

describe('Pi Happier tools extension', () => {
  it.each(['0.81.0', '0.82.1'])('observes input before discovered user handlers through the real Pi %s loader', async (version) => {
    const pi = version === '0.81.0' ? await import('pi-coding-agent-0810') : await import('pi-coding-agent-0821');
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-input-loader-'));
    const agentDir = join(root, 'agent');
    const prepared = await preparePiHappierToolsExtension({ directory: root });
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>['session'] | undefined;
    try {
      const userExtensionPath = join(agentDir, 'extensions', 'user.js');
      mkdirSync(join(agentDir, 'extensions'), { recursive: true });
      writeFileSync(userExtensionPath, `export default function userExtension(pi) {
        pi.on('input', event => {
          if (event.text === 'handled') return { action: 'handled' };
          if (event.text === 'transform me') return { action: 'transform', text: 'transformed by discovered extension' };
        });
      }`);
      const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const modelRuntime = await pi.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false });
      await modelRuntime.setRuntimeApiKey('anthropic', 'test-runtime-key');
      const model = modelRuntime.getModels('anthropic')[0]!;
      const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
        additionalExtensionPaths: [prepared.extensionPath], noSkills: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      const opened = await pi.createAgentSession({ cwd: root, agentDir, settingsManager, modelRuntime, model,
        thinkingLevel: 'off', tools: [], resourceLoader, sessionManager: pi.SessionManager.inMemory(root) });
      session = opened.session;
      expect(opened.extensionsResult.errors).toEqual([]);
      expect(opened.extensionsResult.extensions.map((extension) => extension.path)).toEqual([prepared.extensionPath, userExtensionPath]);
      session.extensionRunner!.setFlagValue(PI_HAPPIER_TOOLS_CONFIG_FLAG, prepared.configPath);
      const observations: unknown[] = [];
      const events: string[] = [];
      await session.bindExtensions({ uiContext: { notify: (message) => { observations.push(JSON.parse(message)); events.push('input'); } } });
      session.subscribe((event) => {
        if (event.type === 'agent_start') events.push('start');
        if (event.type === 'message_end' && event.message.role === 'user') {
          const content = event.message.content;
          events.push(typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
        }
      });
      // The model transport is the only mocked logic; loader, input chain and generated bridge are real.
      session.agent.streamFunction = async () => {
        const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() };
        return { async *[Symbol.asyncIterator]() { yield { type: 'done' as const, reason: 'stop' as const, message }; }, result: async () => message };
      };
      for (const text of ['ordinary host prompt', 'transform me', 'handled']) await session.prompt(text, { source: 'rpc' });
      expect(observations).toEqual([]);
      events.length = 0;
      await session.sendUserMessage('handled');
      await session.sendUserMessage('handled');
      expect(observations).toEqual([
        { type: 'happy-pi-user-input', text: 'handled' },
        { type: 'happy-pi-user-input', text: 'handled' },
      ]);
      expect(events).toEqual(['input', 'input']);
      await session.sendUserMessage('transform me');
      expect(observations.at(-1)).toEqual({ type: 'happy-pi-user-input', text: 'transform me' });
      expect(events).toEqual(['input', 'input', 'input', 'start', 'transformed by discovered extension']);
    } finally {
      session?.dispose();
      await prepared.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports extension-submitted input through native UI notifications before user input handlers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-input-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ v: 1, directory: root, systemPrompt: '', tools: [] }));
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      const module = await import(pathToFileURL(extensionPath).href);
      const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
      const notifications: string[] = [];
      module.default({
        registerFlag() {},
        getFlag: () => configPath,
        on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, handler); },
      });
      const context = { ui: { notify: (message: string) => notifications.push(message) } };
      await handlers.get('session_start')?.({}, context);
      const text = '  <system-reminder>背景 task complete</system-reminder>\n';
      for (const source of ['rpc', 'interactive', 'extension', 'extension']) {
        await handlers.get('input')?.({ source, text }, context);
      }
      await handlers.get('input')?.({ source: 'extension', text: '' }, context);
      expect(notifications.map((message) => JSON.parse(message))).toEqual([
        { type: 'happy-pi-user-input', text },
        { type: 'happy-pi-user-input', text },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not expose input notifications when standalone Pi discovers an unconfigured bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-input-unconfigured-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      const module = await import(pathToFileURL(extensionPath).href);
      const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
      const notifications: string[] = [];
      module.default({ registerFlag() {}, getFlag: () => undefined,
        on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, handler); } });
      const context = { ui: { notify: (message: string) => notifications.push(message) } };
      await handlers.get('session_start')?.({}, context);
      await handlers.get('input')?.({ source: 'extension', text: 'private standalone prompt' }, context);
      expect(notifications).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers exactly the host manifest and appends the canonical system prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: 'HAPPIER_SYSTEM',
        tools: [{
          name: 'host_tool',
          title: 'Host tool',
          description: 'Host resolved',
          inputSchema: { type: 'object', properties: {} },
        }],
        launch: { executablePath: process.execPath, argsPrefix: [] },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      const tools: Array<Readonly<{ name: string }>> = [];
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: Readonly<{ name: string }>) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});
      expect(tools.map((tool) => tool.name)).toEqual(['host_tool']);
      let result: unknown;
      for (const handler of handlers.get('before_agent_start') ?? []) {
        result = await handler({ systemPrompt: 'PI_SYSTEM' });
      }
      expect(result).toEqual({ systemPrompt: 'PI_SYSTEM\n\nHAPPIER_SYSTEM' });
      // A native resume starts a new extension instance with the host's new config.
      // The previous instance retains its own plan; neither instance edits the Pi base.
      const revisedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      revisedConfig.systemPrompt = 'REVISED_ROLE_AND_WORKER';
      writeFileSync(configPath, JSON.stringify(revisedConfig));
      const resumedHandlers = new Map<string, Array<(event: unknown) => unknown>>();
      module.default({
        registerFlag() {},
        getFlag: () => configPath,
        registerTool() {},
        on(name: string, handler: (event: unknown) => unknown) {
          resumedHandlers.set(name, [...(resumedHandlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of resumedHandlers.get('session_start') ?? []) await handler({});
      for (const handler of resumedHandlers.get('before_agent_start') ?? []) {
        expect(await handler({ systemPrompt: 'PI_SYSTEM' })).toEqual({
          systemPrompt: 'PI_SYSTEM\n\nREVISED_ROLE_AND_WORKER',
        });
      }
      for (const handler of handlers.get('before_agent_start') ?? []) {
        expect(await handler({ systemPrompt: 'PI_SYSTEM' })).toEqual({
          systemPrompt: 'PI_SYSTEM\n\nHAPPIER_SYSTEM',
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contains no provider-owned tool inventory', () => {
    const source = buildPiHappierToolsExtensionSource();
    expect(source).not.toContain('memory_search');
    expect(source).not.toContain('change_title');
    expect(source).toContain('for (const tool of config.tools)');
    expect(source).not.toContain('TIMEOUT_MS');
    expect(source).toContain('BRIDGE_OUTPUT_MAX_BYTES');
  });

  it('rejects malformed host manifests instead of partially registering them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-invalid-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: '',
        tools: [{ name: 'missing_schema', title: 'Broken', description: 'Broken' }],
        launch: { executablePath: process.execPath, argsPrefix: [] },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const tools: Array<Readonly<{ name: string }>> = [];
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: Readonly<{ name: string }>) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});
      expect(tools).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds oversized native tool results before returning them to Pi', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-bounds-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      const payload = '😀'.repeat(20 * 1024);
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: '',
        tools: [{
          name: 'host_tool',
          title: 'Host tool',
          description: 'Host resolved',
          inputSchema: { type: 'object', properties: {} },
        }],
        launch: {
          executablePath: process.execPath,
          argsPrefix: ['-e', `process.stdout.write(JSON.stringify({ ok: true, data: { output: ${JSON.stringify(payload)} } }) + "\\n")`, '--'],
        },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      const tools: Array<Readonly<{
        name: string;
        execute: (...args: unknown[]) => Promise<Readonly<{
          content: readonly Readonly<{ type: string; text: string }>[];
          details?: unknown;
        }>>;
      }>> = [];
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});

      const result = await tools[0]?.execute('call-1', {}, undefined, undefined, { cwd: root });

      expect(Buffer.byteLength(result?.content[0]?.text ?? '', 'utf8')).toBeLessThanOrEqual(50 * 1024);
      expect(result?.content[0]?.text).not.toContain('�');
      expect(result?.content[0]?.text).toContain('[Happier tool output truncated');
      expect(JSON.stringify(result?.details ?? {})).not.toContain(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminates a bridge process that stays alive after exceeding the transport limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-transport-limit-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: '',
        tools: [{
          name: 'host_tool',
          title: 'Host tool',
          description: 'Host resolved',
          inputSchema: { type: 'object', properties: {} },
        }],
        launch: {
          executablePath: process.execPath,
          argsPrefix: ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)', '--'],
        },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      const tools: Array<Readonly<{ execute: (...args: unknown[]) => Promise<unknown> }>> = [];
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});

      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 500);
      try {
        await expect(tools[0]?.execute('call-1', {}, controller.signal, undefined, { cwd: root }))
          .rejects.toThrow('bridge_output_limit');
      } finally {
        clearTimeout(abortTimer);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when the Happier bridge returns a failed tool envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-error-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: '',
        tools: [{
          name: 'host_tool',
          title: 'Host tool',
          description: 'Host resolved',
          inputSchema: { type: 'object', properties: {} },
        }],
        launch: {
          executablePath: process.execPath,
          argsPrefix: ['-e', 'process.stdout.write(JSON.stringify({ ok: false, error: { code: "action_failed", message: "expected failure" } }) + "\\n")', '--'],
        },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      const tools: Array<Readonly<{
        execute: (...args: unknown[]) => Promise<unknown>;
      }>> = [];
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});

      await expect(tools[0]?.execute('call-1', {}, undefined, undefined, { cwd: root }))
        .rejects.toThrow('action_failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces a bounded diagnostic when the bridge process exits without an envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-tools-process-error-test-'));
    try {
      const extensionPath = join(root, 'extension.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'session-1',
        directory: root,
        systemPrompt: '',
        tools: [{
          name: 'host_tool',
          title: 'Host tool',
          description: 'Host resolved',
          inputSchema: { type: 'object', properties: {} },
        }],
        launch: {
          executablePath: process.execPath,
          argsPrefix: ['-e', 'process.stderr.write("deterministic bridge diagnostic"); process.exit(7)', '--'],
        },
      }));
      const module = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
      const handlers = new Map<string, Array<(event: unknown) => unknown>>();
      const tools: Array<Readonly<{ execute: (...args: unknown[]) => Promise<unknown> }>> = [];
      module.default({
        registerFlag() {},
        getFlag(name: string) {
          return name === PI_HAPPIER_TOOLS_CONFIG_FLAG ? configPath : undefined;
        },
        registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
        on(name: string, handler: (event: unknown) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});

      const processFailure = tools[0]?.execute('call-1', {}, undefined, undefined, { cwd: root });
      await expect(processFailure).rejects.toThrow('code=bridge_process_failed');
      await expect(processFailure).rejects.toThrow('code 7');
      await expect(processFailure).rejects.toThrow('deterministic bridge diagnostic');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards Pi tool-call identity through the native Agent bridge', async () => {
    const source = buildPiHappierToolsExtensionSource();
    expect(source).toContain('"--tool-call-id", callId.trim()');
    expect(source).toContain('await invoke(config, tool.name, args, callId, signal, cwd)');
  });
});
