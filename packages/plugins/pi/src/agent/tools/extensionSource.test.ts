import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildPiHappierToolsExtensionSource,
  PI_HAPPIER_TOOLS_CONFIG_FLAG,
} from './extensionSource.js';

describe('Pi Happier tools extension', () => {
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
      const payload = 'x'.repeat(60 * 1024);
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

      expect(result?.content[0]?.text.length).toBeLessThanOrEqual(50 * 1024);
      expect(result?.content[0]?.text).toContain('[Happier tool output truncated');
      expect(JSON.stringify(result?.details ?? {})).not.toContain(payload);
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

  it('forwards Pi tool-call identity through the native Agent bridge', async () => {
    const source = buildPiHappierToolsExtensionSource();
    expect(source).toContain('"--tool-call-id", callId.trim()');
    expect(source).toContain('await invoke(config, tool.name, args, callId, signal, cwd)');
  });
});
