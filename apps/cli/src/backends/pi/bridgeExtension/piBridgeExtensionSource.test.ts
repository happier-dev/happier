import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildPiBridgeExtensionSource,
  PI_BRIDGE_EXTENSION_VERSION,
  type PiBridgeExtensionSourceParams,
} from './piBridgeExtensionSource';
import {
  PI_BRIDGE_MEMORY_MACHINE_ID_FLAG,
  PI_BRIDGE_PROMPT_OPTIONS_FLAG,
  PI_BRIDGE_SESSION_ID_FLAG,
  PI_BRIDGE_SESSION_RENAME_FLAG,
  PI_BRIDGE_SESSION_TOOLS_FLAG,
  PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE,
} from './piBridgeExtensionEnv';

function baseParams(overrides?: Partial<PiBridgeExtensionSourceParams>): PiBridgeExtensionSourceParams {
  return {
    launchFilePath: '/usr/bin/node',
    launchArgPrefix: ['--no-warnings', 'dist/index.mjs'],
    launchEnv: {},
    ...overrides,
  };
}

describe('buildPiBridgeExtensionSource', () => {
  it('bakes the flag contract and version into the generated source', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain(`Version: ${PI_BRIDGE_EXTENSION_VERSION}`);
    expect(source).toContain(`"${PI_BRIDGE_SESSION_ID_FLAG}"`);
    expect(source).toContain(`"${PI_BRIDGE_SESSION_RENAME_FLAG}"`);
    expect(source).toContain(`"${PI_BRIDGE_PROMPT_OPTIONS_FLAG}"`);
    expect(source).toContain(`"${PI_BRIDGE_MEMORY_MACHINE_ID_FLAG}"`);
    // The retired disable-flag contract must not survive in the asset.
    expect(source).not.toContain('happy-disable-rename');
    expect(source).not.toContain('happy-disable-memory');
    expect(source).not.toContain('HAPPIER_PI_BRIDGE_MEMORY_MACHINE_ID');
  });

  it('bakes the Happier CLI launch spec', () => {
    const source = buildPiBridgeExtensionSource(baseParams({
      launchFilePath: '/opt/happier/node',
      launchArgPrefix: ['--no-warnings', '--no-deprecation', '/opt/happier/dist/index.mjs'],
      launchEnv: { TSX_TSCONFIG_PATH: '/opt/happier/tsconfig.json' },
    }));
    expect(source).toContain('"/opt/happier/node"');
    expect(source).toContain('"/opt/happier/dist/index.mjs"');
    expect(source).toContain('TSX_TSCONFIG_PATH');
  });

  it('declares the advertised tool names (change_title, memory_search, memory_get_window)', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain('name: "change_title"');
    expect(source).toContain('name: "memory_search"');
    expect(source).toContain('name: "memory_get_window"');
    expect(source.match(/pi\.registerTool\(/g)?.length).toBe(4);
  });

  it('inlines the session-agent tool table and gates it behind --happy-session-tools', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    // The flag contract is registered so Pi accepts it on the command line.
    expect(source).toContain(`"${PI_BRIDGE_SESSION_TOOLS_FLAG}"`);
    // The session-agent tool table is inlined from the protocol action specs — spot-check
    // a cross-session tool, a spawn tool, and the umbrella from the canonical catalog.
    expect(source).toContain('SESSION_AGENT_TOOL_DEFS');
    expect(source).toContain('"session_list"');
    expect(source).toContain('"session_message_send"');
    expect(source).toContain('"session_wait_idle"');
    expect(source).toContain('"session_spawn_new"');
    expect(source).toContain('"action_execute"');
    // Registration is gated on the flag; absent flag keeps the full set off.
    expect(source).toMatch(/readFlagBool\(pi, SESSION_TOOLS_FLAG\)/);
  });

  it('excludes spec-only actions without tool bindings from the inlined table', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    // machines.list / paths.list_recent / servers.list / prompt_doc.update /
    // session.mode.set / approval.request.create have no mcpToolName; they are only
    // reachable through action_execute and must not appear as standalone rows.
    expect(source.match(/"machines\.list"/g)).toBeNull();
    expect(source.match(/"paths\.list_recent"/g)).toBeNull();
    expect(source.match(/"session\.mode\.set"/g)).toBeNull();
  });

  it('stays inert without the session binding flag', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain('if (!readFlagString(pi, SESSION_ID_FLAG)) return;');
  });

  it('is self-contained: no Happier imports', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).not.toMatch(/from ['"]@\//);
    expect(source).not.toMatch(/from ['"]@happier-dev\//);
    expect(source).toContain('import { spawn } from "node:child_process";');
    expect(source).toContain('import { Type } from "typebox";');
    expect(source.match(/^import /gm)?.length).toBe(2);
  });

  it('bridges through the happier tools CLI call form', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain('"tools"');
    expect(source).toContain('"call"');
    expect(source).toContain('"--session-id"');
    expect(source).toContain('"--source"');
    expect(source).toContain('"happier"');
    expect(source).toContain('"--tool"');
    expect(source).toContain('"--args-json"');
    expect(source).toContain('"--json"');
  });

  it('emits syntactically valid JavaScript', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-syntax-'));
    try {
      const file = join(dir, 'happier-pi-tools-bridge.mjs');
      writeFileSync(file, source, 'utf8');
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pi bridge extension context telemetry emission', () => {
  it('bakes the shared marker type constant and an assistant-gated message_end listener', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain(`"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}"`);
    expect(source).toContain('pi.on("message_end"');
    expect(source).toContain('message.role !== "assistant"');
    expect(source).toContain('getContextUsage');
    expect(source).toContain('process.stderr.write(JSON.stringify({ type: TOKEN_COUNT_MARKER_TYPE');
  });

  it('registers the listener inside the session-bound branch (inert without the binding)', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    const boundBranchStart = source.indexOf('registered = true;');
    const listenerStart = source.indexOf('pi.on("message_end"');
    const toolsStart = source.indexOf('pi.registerTool({');
    expect(boundBranchStart).toBeGreaterThan(-1);
    expect(listenerStart).toBeGreaterThan(boundBranchStart);
    expect(toolsStart).toBeGreaterThan(listenerStart);
  });
});

// ---------------------------------------------------------------------------
// Behavior tests: load the real generated artifact as an ESM module and drive
// its factory through a stub `pi` exposing the same registration + flag surface
// as Pi's extension runtime. typebox (a real runtime dep provided by Pi's jiti
// runtime) is stubbed at this genuine external boundary; the schemas it builds
// are not under test.
// ---------------------------------------------------------------------------

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
};
type EventHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;

const TYPEBOX_STUB = [
  'export const Type = {',
  '  Object: (properties, opts = {}) => ({ properties, ...opts }),',
  '  String: (opts = {}) => ({ type: "string", ...opts }),',
  '  Integer: (opts = {}) => ({ type: "integer", ...opts }),',
  '  Number: (opts = {}) => ({ type: "number", ...opts }),',
  '  Boolean: (opts = {}) => ({ type: "boolean", ...opts }),',
  '  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),',
  '  Union: (variants) => ({ anyOf: variants }),',
  '  Unsafe: (schema) => schema,',
  '  Any: (opts = {}) => ({ ...opts }),',
  '  Optional: (schema) => ({ optional: true, ...schema }),',
  '};',
].join('\n');

type FakePi = {
  pi: {
    registerFlag: (name: string, def: Record<string, unknown>) => void;
    registerTool: (def: ToolDef) => void;
    getFlag: (name: string) => unknown;
    on: (event: string, handler: EventHandler) => void;
  };
  registeredFlags: string[];
  tools: ToolDef[];
  emit: (event: string, event_: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
};

function createFakePi(flags: Readonly<Record<string, string | boolean>>): FakePi {
  const handlers = new Map<string, EventHandler[]>();
  const tools: ToolDef[] = [];
  const registeredFlags: string[] = [];
  return {
    pi: {
      registerFlag: (name) => registeredFlags.push(name),
      registerTool: (def) => tools.push(def),
      getFlag: (name) => flags[name],
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    },
    registeredFlags,
    tools,
    emit: async (event, event_, ctx) => {
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) {
        last = await handler(event_, ctx);
      }
      return last;
    },
  };
}

async function loadExtensionFactory(): Promise<(pi: FakePi['pi']) => void> {
  const dir = mkdtempSync(join(tmpdir(), 'happier-pi-bridge-ext-'));
  const typeboxDir = join(dir, 'node_modules', 'typebox');
  mkdirSync(typeboxDir, { recursive: true });
  writeFileSync(join(typeboxDir, 'package.json'), JSON.stringify({ name: 'typebox', version: '0.0.0', type: 'module', main: 'index.mjs' }));
  writeFileSync(join(typeboxDir, 'index.mjs'), TYPEBOX_STUB);
  const file = join(dir, `ext-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, buildPiBridgeExtensionSource(baseParams()), 'utf8');
  try {
    const mod = await import(pathToFileURL(file).href);
    expect(typeof mod.default).toBe('function');
    return mod.default as (pi: FakePi['pi']) => void;
  } finally {
    // Node keeps the module in cache; remove the source so failures re-materialize it.
    rmSync(dir, { recursive: true, force: true });
  }
}

async function driveExtension(flags: Readonly<Record<string, string | boolean>>): Promise<{
  harness: FakePi;
  beforeAgentStartResult: unknown;
}> {
  const factory = await loadExtensionFactory();
  const harness = createFakePi(flags);
  factory(harness.pi);
  await harness.emit('session_start', {});
  const beforeAgentStartResult = await harness.emit('before_agent_start', { systemPrompt: 'PI_BASE_PROMPT' });
  return { harness, beforeAgentStartResult };
}

describe('pi bridge extension behavior (generated artifact, exercised live)', () => {
  it('registers a flag for every launch-config surface', async () => {
    const factory = await loadExtensionFactory();
    const harness = createFakePi({});
    factory(harness.pi);
    expect(harness.registeredFlags).toEqual([
      PI_BRIDGE_SESSION_ID_FLAG,
      PI_BRIDGE_SESSION_RENAME_FLAG,
      PI_BRIDGE_PROMPT_OPTIONS_FLAG,
      PI_BRIDGE_MEMORY_MACHINE_ID_FLAG,
      PI_BRIDGE_SESSION_TOOLS_FLAG,
    ]);
  });

  it('registers the full session-agent tool surface only when --happy-session-tools is set', async () => {
    // Without the flag: only the curated special cases (none active without their own flags).
    const off = await driveExtension({ [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1' });
    expect(off.harness.tools.map((t) => t.name)).toEqual([]);

    // With the flag: the inlined session-agent table registers (48 action-bound rows +
    // action_execute; the three curated special cases stay out of the table).
    const on = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_SESSION_TOOLS_FLAG]: true,
    });
    const names = on.harness.tools.map((t) => t.name);
    expect(names).toContain('session_list');
    expect(names).toContain('session_message_send');
    expect(names).toContain('session_wait_idle');
    expect(names).toContain('session_spawn_new');
    expect(names).toContain('action_execute');
    // Curated special cases are absent from the table (they register via their own flags).
    expect(names).not.toContain('change_title');
    expect(names).not.toContain('memory_search');
    // Spec-only actions (no tool binding) are not standalone rows.
    expect(names).not.toContain('machines_list');
    expect(names.length).toBe(49);
  });

  it('converts inlined JSON Schema parameters to typebox-compatible shapes', async () => {
    const on = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_SESSION_TOOLS_FLAG]: true,
    });
    const sessionList = on.harness.tools.find((t) => t.name === 'session_list');
    expect(sessionList).toBeDefined();
    // The parameters object carries the converted properties (typebox objects expose [Kind]/'properties').
    const params = sessionList?.parameters as Record<string, unknown>;
    expect(params && typeof params === 'object').toBe(true);
    const props = (params as { properties?: Record<string, unknown> }).properties;
    expect(props && typeof props === 'object').toBe(true);
    expect(Object.keys(props ?? {})).toContain('limit');
  });

  it('configures tools and appends the Happier prompt addition to the base system prompt', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_SESSION_RENAME_FLAG]: 'ongoing',
      [PI_BRIDGE_PROMPT_OPTIONS_FLAG]: true,
      [PI_BRIDGE_MEMORY_MACHINE_ID_FLAG]: 'machine-1',
    });

    expect(harness.tools.map((tool) => tool.name).sort()).toEqual(['change_title', 'memory_get_window', 'memory_search']);

    const systemPrompt = (beforeAgentStartResult as { systemPrompt?: string } | undefined)?.systemPrompt;
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt?.startsWith('PI_BASE_PROMPT\n\n')).toBe(true);
    expect(systemPrompt).toContain('# Session title');
    expect(systemPrompt).toContain('Call the title tool again if the task changes significantly.');
    expect(systemPrompt).toContain('<options>');
    expect(systemPrompt).toContain('# Attachments');
    expect(systemPrompt).toContain('# Linked workspace files');
    expect(systemPrompt).toContain('# Memory recall');
  });

  it('delivers the first-message-only title block for the initial rename mode', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_SESSION_RENAME_FLAG]: 'initial',
    });

    expect(harness.tools.map((tool) => tool.name)).toEqual(['change_title']);
    const systemPrompt = (beforeAgentStartResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? '';
    expect(systemPrompt).toContain('At the start of the session');
    expect(systemPrompt).not.toContain('Call the title tool again');
    expect(systemPrompt).not.toContain('<options>');
    expect(systemPrompt).not.toContain('# Memory recall');
  });

  it('registers no tools and appends only the always-on blocks when no config flags are passed', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
    });

    expect(harness.tools).toEqual([]);
    const systemPrompt = (beforeAgentStartResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? '';
    expect(systemPrompt).toContain('# Attachments');
    expect(systemPrompt).toContain('# Linked workspace files');
    expect(systemPrompt).not.toContain('# Session title');
    expect(systemPrompt).not.toContain('<options>');
    expect(systemPrompt).not.toContain('# Memory recall');
  });

  it('requires the memory machine-id flag for the memory tools and guidance', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_MEMORY_MACHINE_ID_FLAG]: 'machine-1',
    });

    expect(harness.tools.map((tool) => tool.name).sort()).toEqual(['memory_get_window', 'memory_search']);
    expect((beforeAgentStartResult as { systemPrompt?: string } | undefined)?.systemPrompt).toContain('# Memory recall');
  });

  it('ignores an explicit disabled rename mode (absent flag is the disabled state)', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_ID_FLAG]: 'happy-session-1',
      [PI_BRIDGE_SESSION_RENAME_FLAG]: 'disabled',
    });

    expect(harness.tools).toEqual([]);
    expect((beforeAgentStartResult as { systemPrompt?: string } | undefined)?.systemPrompt).not.toContain('# Session title');
  });

  it('stays inert without the session binding: no tools, no prompt modification', async () => {
    const { harness, beforeAgentStartResult } = await driveExtension({
      [PI_BRIDGE_SESSION_RENAME_FLAG]: 'ongoing',
      [PI_BRIDGE_PROMPT_OPTIONS_FLAG]: true,
      [PI_BRIDGE_MEMORY_MACHINE_ID_FLAG]: 'machine-1',
    });

    expect(harness.tools).toEqual([]);
    expect(beforeAgentStartResult).toBeUndefined();
  });
});
