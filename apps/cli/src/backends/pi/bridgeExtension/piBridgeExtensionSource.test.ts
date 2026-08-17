import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPiBridgeExtensionSource,
  PI_BRIDGE_EXTENSION_VERSION,
  type PiBridgeExtensionSourceParams,
} from './piBridgeExtensionSource';
import {
  PI_BRIDGE_DISABLE_MEMORY_FLAG,
  PI_BRIDGE_DISABLE_RENAME_FLAG,
  PI_BRIDGE_SESSION_ID_FLAG,
  PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE,
} from './piBridgeExtensionEnv';

function baseParams(overrides?: Partial<PiBridgeExtensionSourceParams>): PiBridgeExtensionSourceParams {
  return {
    renameEnabled: true,
    memoryEnabled: true,
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
    expect(source).toContain(`"${PI_BRIDGE_DISABLE_RENAME_FLAG}"`);
    expect(source).toContain(`"${PI_BRIDGE_DISABLE_MEMORY_FLAG}"`);
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

  it('bakes the enablement so disabled tool groups are never registered', () => {
    const enabled = buildPiBridgeExtensionSource(baseParams());
    expect(enabled).toContain('const RENAME_ENABLED = true;');
    expect(enabled).toContain('const MEMORY_ENABLED = true;');

    const disabled = buildPiBridgeExtensionSource(baseParams({ renameEnabled: false, memoryEnabled: false }));
    expect(disabled).toContain('const RENAME_ENABLED = false;');
    expect(disabled).toContain('const MEMORY_ENABLED = false;');
  });

  it('registers exactly the advertised tools (change_title, memory_search, memory_get_window)', () => {
    const source = buildPiBridgeExtensionSource(baseParams());
    expect(source).toContain('name: "change_title"');
    expect(source).toContain('name: "memory_search"');
    expect(source).toContain('name: "memory_get_window"');
    expect(source.match(/pi\.registerTool\(/g)?.length).toBe(3);
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
    // Listener must also be independent of the tool-disable flags: it precedes them.
    const disableRenameRead = source.indexOf('const disableRename');
    expect(listenerStart).toBeGreaterThan(-1);
    expect(listenerStart).toBeLessThan(disableRenameRead);
    expect(toolsStart).toBeGreaterThan(listenerStart);
  });
});
