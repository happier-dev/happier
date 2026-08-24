import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  buildPiBridgeExtensionSource,
  PI_BRIDGE_EXTENSION_VERSION,
} from './piBridgeExtensionSource';
import { PI_BRIDGE_CONFIG_PATH_FLAG, PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from './piBridgeExtensionEnv';

type ToolDef = {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
};
type EventHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function createFakePi(flags: Readonly<Record<string, unknown>>) {
  const handlers = new Map<string, EventHandler[]>();
  const tools: ToolDef[] = [];
  const registeredFlags: string[] = [];
  return {
    pi: {
      registerFlag: (name: string) => registeredFlags.push(name),
      registerTool: (def: ToolDef) => tools.push(def),
      getFlag: (name: string) => flags[name],
      on: (event: string, handler: EventHandler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    },
    registeredFlags,
    tools,
    emit: async (event: string, value: Record<string, unknown>, ctx?: unknown) => {
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) last = await handler(value, ctx);
      return last;
    },
  };
}

async function loadExtensionFactory(): Promise<(pi: ReturnType<typeof createFakePi>['pi']) => void> {
  const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-ext-'));
  const file = join(dir, 'extension.mjs');
  writeFileSync(file, buildPiBridgeExtensionSource(), 'utf8');
  try {
    const mod = await import(`${pathToFileURL(file).href}?nonce=${Math.random()}`);
    return mod.default as (pi: ReturnType<typeof createFakePi>['pi']) => void;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildPiBridgeExtensionSource', () => {
  it('emits a generic self-contained adapter with no provider-owned tool inventory', () => {
    const source = buildPiBridgeExtensionSource();
    expect(source).toContain(`Version: ${PI_BRIDGE_EXTENSION_VERSION}`);
    expect(source).toContain(`"${PI_BRIDGE_CONFIG_PATH_FLAG}"`);
    expect(source).toContain('for (const tool of config.directTools)');
    expect(source).not.toContain('memory_search');
    expect(source).not.toContain('change_title');
    expect(source).not.toMatch(/from ['"]@\//);
    expect(source).not.toMatch(/from ['"]@happier-dev\//);
  });

  it('bridges every manifest tool through the semantic session-Agent call form', () => {
    const source = buildPiBridgeExtensionSource();
    expect(source).toContain('"--session-agent-bridge"');
    expect(source).toContain('"--source", "happier"');
    expect(source).toContain('"--tool", toolName');
    expect(source).toContain('"--args-json", JSON.stringify(args ?? {})');
  });

  it('keeps context telemetry in the session-bound extension lifecycle', () => {
    const source = buildPiBridgeExtensionSource();
    expect(source).toContain(`"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}"`);
    expect(source).toContain('pi.on("message_end"');
    expect(source).toContain('getContextUsage');
  });

  it('emits syntactically valid JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-syntax-'));
    try {
      const file = join(dir, 'extension.mjs');
      writeFileSync(file, buildPiBridgeExtensionSource(), 'utf8');
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pi bridge extension behavior', () => {
  it('executes host-resolved tools through the Agent bridge with bounded typed results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-execute-'));
    try {
      const argvPath = join(dir, 'argv.json');
      const executableScript = join(dir, 'fake-happier-cli.cjs');
      writeFileSync(executableScript, `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const argsIndex = process.argv.indexOf('--args-json');
const args = JSON.parse(process.argv[argsIndex + 1]);
if (args.input.value === 'fail') {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'action_failed', message: 'expected failure' } }) + '\\n');
} else if (args.input.value === 'large') {
  process.stdout.write(JSON.stringify({ ok: true, data: { output: 'x'.repeat(100000) } }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { output: { echoed: args } } }) + '\\n');
}
`, 'utf8');
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'sess-execute',
        directTools: [{
          name: 'host_resolved_tool',
          title: 'Host resolved tool',
          description: 'Resolved by the canonical catalog',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          call: { toolName: 'action_execute', actionId: 'memory.search' },
        }],
        promptAddition: '',
        launch: {
          filePath: process.execPath,
          argPrefix: [executableScript],
          env: { HAPPIER_TEST_BRIDGE: '1' },
        },
      }));
      const factory = await loadExtensionFactory();
      const harness = createFakePi({ [PI_BRIDGE_CONFIG_PATH_FLAG]: configPath });
      factory(harness.pi);
      await harness.emit('session_start', {});

      await expect(harness.tools[0]!.execute(
        'call-1',
        { value: 'ok' },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      )).resolves.toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('memory.search') }],
      });
      const invocation = JSON.parse(readFileSync(argvPath, 'utf8')) as { argv: string[]; cwd: string };
      expect(realpathSync(invocation.cwd)).toBe(realpathSync(dir));
      expect(invocation.argv).toEqual(expect.arrayContaining([
        'tools', 'call',
        '--session-id', 'sess-execute',
        '--directory', dir,
        '--source', 'happier',
        '--tool', 'action_execute',
        '--session-agent-bridge',
        '--json',
      ]));
      const argsIndex = invocation.argv.indexOf('--args-json');
      expect(JSON.parse(invocation.argv[argsIndex + 1]!)).toEqual({
        actionId: 'memory.search',
        input: { value: 'ok' },
      });

      await expect(harness.tools[0]!.execute(
        'call-2',
        { value: 'fail' },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      )).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('action_failed') }],
      });

      const largeResult = await harness.tools[0]!.execute(
        'call-3',
        { value: 'large' },
        new AbortController().signal,
        undefined,
        { cwd: dir },
      ) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
      expect(Buffer.byteLength(largeResult.content[0]!.text, 'utf8')).toBeLessThanOrEqual(50 * 1024);
      expect(largeResult.content[0]!.text).toContain('[Output truncated');
      expect(largeResult.details).not.toHaveProperty('envelope');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers exactly the host-resolved manifest and appends its prompt addition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-config-'));
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        v: 1,
        sessionId: 'sess-1',
        directTools: [{
          name: 'host_resolved_tool',
          title: 'Host resolved tool',
          description: 'Resolved by the canonical catalog',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          call: { toolName: 'action_execute', actionId: 'session.status.get' },
        }],
        promptAddition: 'HOST_RESOLVED_GUIDANCE',
        launch: { filePath: process.execPath, argPrefix: [], env: {} },
      }));
      const factory = await loadExtensionFactory();
      const harness = createFakePi({ [PI_BRIDGE_CONFIG_PATH_FLAG]: configPath });
      factory(harness.pi);
      expect(harness.registeredFlags).toEqual([PI_BRIDGE_CONFIG_PATH_FLAG]);
      await harness.emit('session_start', {});

      expect(harness.tools.map((tool) => tool.name)).toEqual(['host_resolved_tool']);
      expect(harness.tools[0]?.parameters).toEqual(expect.objectContaining({ required: ['value'] }));
      await expect(harness.emit('before_agent_start', { systemPrompt: 'PI_BASE' })).resolves.toEqual({
        systemPrompt: 'PI_BASE\n\nHOST_RESOLVED_GUIDANCE',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays inert without a valid protected config binding', async () => {
    const factory = await loadExtensionFactory();
    const harness = createFakePi({});
    factory(harness.pi);
    await harness.emit('session_start', {});
    expect(harness.tools).toEqual([]);
    await expect(harness.emit('before_agent_start', { systemPrompt: 'PI_BASE' })).resolves.toBeUndefined();
  });
});
