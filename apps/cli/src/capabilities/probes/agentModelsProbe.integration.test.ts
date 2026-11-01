import { describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { probeAgentModelsBestEffort, probeModelsFromAcpBackend } from './agentModelsProbe';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createFx014SessionResponse, writeFx014AcpAgentScript } from '@/agent/acp/testkit/fx014';
import { withTempDir } from '@/testkit/fs/tempDir';
import {
  createProbeTempDir,
  resolveAcpSdkEntryFromCwd,
  writeExecutableScript,
  writeFakeAcpAgentScript,
} from './agentModelsProbe.testkit';

const CLI_MODELS_PROBE_TEST_TIMEOUT_MS = 5_000;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function createProbeBackendOptions(params: {
  cwd: string;
  agentPath: string;
  permissionHandler?: AcpPermissionHandler;
}): AcpBackendOptions {
  return {
    agentName: 'fake',
    cwd: params.cwd,
    command: process.execPath,
    args: [params.agentPath],
    env: { NODE_ENV: 'production' },
    permissionHandler: params.permissionHandler ?? createApprovedPermissionHandler(),
  };
}

type ProbeBackendLike = Pick<AgentBackend, 'startSession'> & {
  getSessionModelState: () => unknown;
  getSessionConfigOptionsState: () => unknown;
};

describe('probeModelsFromAcpBackend', () => {
  it('uses an explicit opaque selector id and recursively grouped choices ahead of a model-labelled decoy', async () => {
    await withTempDir('happier-acp-explicit-probe-', async (dir) => {
      const [provider, model, ...controls] = createFx014SessionResponse().configOptions;
      const selector = { ...model, id: ' vendor/selector ', name: 'Engine selection', options: [
        { name: 'Outer', options: [{ name: 'Inner', options: model.options }] },
      ] };
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFx014AcpAgentScript({ dir, configOptions: [
          provider, { ...provider, id: 'model', name: 'Model' }, selector, ...controls,
        ] })],
      });
      try {
        const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000, modelConfigOptionId: selector.id });
        expect(models?.map((entry) => entry.id)).toEqual(['default', ...model.options.map((choice) => choice.value)]);
        expect(models?.find((entry) => entry.id === model.currentValue)?.modelOptions?.map((option) => option.id)).toEqual(['effort', 'fast']);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('rejects an ambiguous category-only model projection', async () => {
    await withTempDir('happier-acp-ambiguous-probe-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFx014AcpAgentScript({ dir, configOptions: createFx014SessionResponse().configOptions.filter((option) => option.id !== 'model') })],
      });
      try {
        expect(await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 })).toBeNull();
        expect(backend.getSessionConfigOptionsState()?.map((option) => option.id)).toContain('provider');
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each([false, true])('selects FX models rather than providers or fast controls (reordered: %s)', async (reordered) => {
    await withTempDir('happier-fx014-probe-', async (dir) => {
      const response = createFx014SessionResponse();
      const backend = new AcpBackend({
        agentName: 'fx', cwd: dir, command: process.execPath,
        args: [writeFx014AcpAgentScript({ dir, configOptions: reordered ? [...response.configOptions].reverse() : response.configOptions })],
      });
      try {
        const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 });
        expect(models?.map((model) => model.id)).toEqual(['default', ...response.configOptions[1].options.map((choice) => choice.value)]);
        expect(models?.find((model) => model.id === 'gpt-6.1-sol')?.modelOptions?.map((option) => option.id).sort()).toEqual(['effort', 'fast']);
        expect(models?.filter((model) => model.id !== 'gpt-6.1-sol').every((model) => !model.modelOptions)).toBe(true);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('extracts available models from ACP session/new and normalizes Default', async () => {
    const fixture = await createProbeTempDir('happier-acp-model-probe');
    const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());

    const agentPath = await writeFakeAcpAgentScript({
      dir: fixture.dir,
      sdkEntry,
      sessionPayloadSource: `{
      sessionId: randomUUID(),
      models: {
        currentModelId: "model-a",
        availableModels: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
        ],
      },
    }`,
    });

    const backend = new AcpBackend(
      createProbeBackendOptions({
        cwd: fixture.dir,
        agentPath,
      }),
    );
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 });
      expect(models).not.toBeNull();
      expect(models?.[0]).toEqual({ id: 'default', name: 'Default' });
      expect(models?.some((m) => m.id === 'model-a' && m.name === 'Model A')).toBe(true);
      expect(models?.some((m) => m.id === 'model-b' && m.name === 'Model B')).toBe(true);
    } finally {
      await backend.dispose().catch(() => {});
      await fixture.cleanup();
    }
  }, 20_000);

  it('extracts Kimi-style modelId entries from ACP session/new', async () => {
    const fixture = await createProbeTempDir('happier-acp-kimi-model-probe');
    const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());

    const agentPath = await writeFakeAcpAgentScript({
      dir: fixture.dir,
      sdkEntry,
      sessionPayloadSource: `{
      sessionId: randomUUID(),
      models: {
        currentModelId: "kimi-code/kimi-for-coding,thinking",
        availableModels: [
          { modelId: "kimi-code/kimi-for-coding", name: "kimi-for-coding" },
          { modelId: "kimi-code/kimi-for-coding,thinking", name: "kimi-for-coding (thinking)" },
        ],
      },
    }`,
    });

    const backend = new AcpBackend(
      createProbeBackendOptions({
        cwd: fixture.dir,
        agentPath,
      }),
    );
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 });
      expect(models).toEqual([
        { id: 'default', name: 'Default' },
        { id: 'kimi-code/kimi-for-coding', name: 'kimi-for-coding' },
        { id: 'kimi-code/kimi-for-coding,thinking', name: 'kimi-for-coding (thinking)' },
      ]);
    } finally {
      await backend.dispose().catch(() => {});
      await fixture.cleanup();
    }
  }, 20_000);

  it('extracts available models from ACP session/new configOptions when models are absent', async () => {
    const fixture = await createProbeTempDir('happier-acp-model-probe-config');
    const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());

    const agentPath = await writeFakeAcpAgentScript({
      dir: fixture.dir,
      sdkEntry,
      sessionPayloadSource: `{
      sessionId: randomUUID(),
      configOptions: [
        {
          id: "cursor-choice",
          name: "Cursor Choice",
          category: "model",
          type: "enum",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "true",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ],
    }`,
    });

    const backend = new AcpBackend(
      createProbeBackendOptions({
        cwd: fixture.dir,
        agentPath,
      }),
    );
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 });
      expect(models).not.toBeNull();
      expect(models?.[0]).toEqual({ id: 'default', name: 'Default' });
      expect(models?.some((m) => m.id === 'model-a' && m.name === 'Model A')).toBe(true);
      expect(models?.some((m) => m.id === 'model-b' && m.name === 'Model B')).toBe(true);
      expect(models?.find((m) => m.id === 'model-a')?.modelOptions).toEqual([
        {
          id: 'fast',
          name: 'Fast',
          type: 'select',
          currentValue: 'true',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ]);
    } finally {
      await backend.dispose().catch(() => {});
      await fixture.cleanup();
    }
  }, 20_000);

  it.each([true, false])('keeps session model options on the observed current model (models payload: %s)', async (withModels) => {
    const fixture = await createProbeTempDir('happier-acp-model-probe-scoped');
    const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());
    const effort = {
      id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level',
      type: 'select', currentValue: 'high',
      options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
    };
    const payload = {
      sessionId: 'scoped-probe-session',
      ...(withModels ? { models: {
        currentModelId: 'model-a',
        availableModels: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
      } } : {}),
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a',
          options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
        effort,
        { id: 'approval', name: 'Approval', type: 'select', currentValue: 'ask',
          options: [{ value: 'ask', name: 'Ask' }] },
      ],
    };
    const agentPath = await writeFakeAcpAgentScript({ dir: fixture.dir, sdkEntry, sessionPayloadSource: JSON.stringify(payload) });
    const backend = new AcpBackend(createProbeBackendOptions({ cwd: fixture.dir, agentPath }));
    try {
      const models = await probeModelsFromAcpBackend({ backend, timeoutMs: 10_000 });
      const { category: _category, ...expectedEffort } = effort;
      expect(models?.find((model) => model.id === 'model-a')?.modelOptions).toEqual([expectedEffort]);
      expect(models?.find((model) => model.id === 'model-b')?.modelOptions).toBeUndefined();
      expect(models?.find((model) => model.id === 'default')?.modelOptions).toBeUndefined();
    } finally {
      await backend.dispose();
      await fixture.cleanup();
    }
  }, 20_000);

  it('does not leak unhandled rejections when startSession times out first', async () => {
    let rejectStartSession!: (reason?: unknown) => void;
    const startSessionPromise = new Promise<Awaited<ReturnType<AgentBackend['startSession']>>>((_resolve, reject) => {
      rejectStartSession = reject;
    });
    const backend: ProbeBackendLike = {
      startSession: () => startSessionPromise,
      getSessionModelState: () => null,
      getSessionConfigOptionsState: () => null,
    };

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await expect(probeModelsFromAcpBackend({ backend: backend as unknown as AgentBackend, timeoutMs: 1 })).rejects.toThrow(/ACP startSession timeout/i);
      rejectStartSession(new Error('late startSession rejection'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not leak unhandled rejections when startSession resolves before timeout', async () => {
    const backend: ProbeBackendLike = {
      startSession: async () =>
        ({ sessionId: 'session-ok' }) as Awaited<ReturnType<AgentBackend['startSession']>>,
      getSessionModelState: () => ({
        availableModels: [{ id: 'model-a', name: 'Model A' }],
      }),
      getSessionConfigOptionsState: () => null,
    };

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const models = await probeModelsFromAcpBackend({
        backend: backend as unknown as AgentBackend,
        timeoutMs: 250,
      });
      expect(models).toEqual([
        { id: 'default', name: 'Default' },
        { id: 'model-a', name: 'Model A' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('clears the startSession timeout timer when startSession resolves first', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const backend: ProbeBackendLike = {
      startSession: async () =>
        ({ sessionId: 'session-ok' }) as Awaited<ReturnType<AgentBackend['startSession']>>,
      getSessionModelState: () => ({
        availableModels: [{ id: 'model-a', name: 'Model A' }],
      }),
      getSessionConfigOptionsState: () => null,
    };

    try {
      const models = await probeModelsFromAcpBackend({
        backend: backend as unknown as AgentBackend,
        timeoutMs: 250,
      });
      expect(models).toEqual([
        { id: 'default', name: 'Default' },
        { id: 'model-a', name: 'Model A' },
      ]);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe('probeAgentModelsBestEffort', () => {
  it('returns dynamic model list from `opencode models` when available', async () => {
    const fixture = await createProbeTempDir('happier-cli-model-probe');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

	    const opencodePath = resolve(join(binDir, 'opencode'));
	    await writeExecutableScript(
	      opencodePath,
	      `#!/usr/bin/env node
	const args = process.argv.slice(2);
	if (args[0] === "models" && args.includes("--verbose")) {
	  process.stdout.write(
	    "openai/gpt-4.1\\n"
	    + "{\\n"
	    + "  \\"id\\": \\"gpt-4.1\\",\\n"
	    + "  \\"providerID\\": \\"openai\\",\\n"
	    + "  \\"name\\": \\"GPT-4.1\\",\\n"
	    + "  \\"family\\": \\"gpt-4.1\\",\\n"
	    + "  \\"status\\": \\"active\\",\\n"
	    + "  \\"capabilities\\": { \\"toolcall\\": true, \\"reasoning\\": true, \\"input\\": { \\"text\\": true } },\\n"
	    + "  \\"variants\\": {\\n"
	    + "    \\"low\\": { \\"reasoningEffort\\": \\"low\\" },\\n"
	    + "    \\"medium\\": { \\"reasoningEffort\\": \\"medium\\" },\\n"
	    + "    \\"high\\": { \\"reasoningEffort\\": \\"high\\" }\\n"
	    + "  }\\n"
	    + "}\\n"
	    + "openai/gpt-4.1-mini\\n"
	    + "{\\n"
	    + "  \\"id\\": \\"gpt-4.1-mini\\",\\n"
	    + "  \\"providerID\\": \\"openai\\",\\n"
	    + "  \\"name\\": \\"GPT-4.1 Mini\\",\\n"
	    + "  \\"family\\": \\"gpt-4.1\\",\\n"
	    + "  \\"status\\": \\"active\\",\\n"
	    + "  \\"capabilities\\": { \\"toolcall\\": true, \\"reasoning\\": false, \\"input\\": { \\"text\\": true } }\\n"
	    + "}\\n"
	  );
	  process.exit(0);
	}
	if (args[0] === "models") {
	  process.stdout.write("openai/gpt-4.1\\nopenai/gpt-4.1-mini\\n");
	  process.exit(0);
	}
	process.exit(1);
	`,
	    );

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_OPENCODE_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    delete process.env.HAPPIER_OPENCODE_PATH;
    try {
      const res = await probeAgentModelsBestEffort({
        agentId: 'opencode',
        cwd: fixture.dir,
        timeoutMs: CLI_MODELS_PROBE_TEST_TIMEOUT_MS,
      });
	      expect(res.source).toBe('dynamic');
	      expect(res.availableModels[0]).toEqual({ id: 'default', name: 'Default' });
	      expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1')).toBe(true);
	      expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1-mini')).toBe(true);
	      expect(res.availableModels).toContainEqual(expect.objectContaining({
	        id: 'openai/gpt-4.1',
	        modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
	      }));
	    } finally {
	      process.env.PATH = prevPath;
	      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OPENCODE_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OPENCODE_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);

  it('runs `opencode models` via opencode.CMD on PATH on Windows when only the .CMD shim exists', async () => {
    const fixture = await createProbeTempDir('happier-cli-model-probe-win32');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const opencodePath = resolve(join(binDir, 'opencode.CMD'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "--verbose") {
  process.stdout.write(
    'openai/gpt-4.1\\n{"id":"gpt-4.1","providerID":"openai","name":"GPT-4.1","capabilities":{"toolcall":true}}\\n' +
    'openai/gpt-4.1-mini\\n{"id":"gpt-4.1-mini","providerID":"openai","name":"GPT-4.1 Mini","capabilities":{"toolcall":true}}\\n'
  );
  process.exit(0);
}
process.exit(1);
`,
    );

    const cmdExePath = resolve(join(binDir, 'cmd.exe'));
    await writeExecutableScript(
      cmdExePath,
      `#!/usr/bin/env node
const cp = require('node:child_process');

function splitCommandLine(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    let ch = raw[i];
    if (ch === '^' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === ' ' || next === '\\t') {
        current += next;
        continue;
      }
      ch = next;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\\t')) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const args = process.argv.slice(2);
const cIndex = args.findIndex((a) => String(a).toLowerCase() === '/c');
const rest = cIndex === -1 ? [] : args.slice(cIndex + 1);
if (rest.length === 0) process.exit(1);

let commandLine = rest.join(' ');
if (rest.length === 1) commandLine = rest[0];
if (commandLine.startsWith('"') && commandLine.endsWith('"')) commandLine = commandLine.slice(1, -1);

const tokens = splitCommandLine(commandLine);
if (tokens.length === 0) process.exit(1);

const command = tokens[0];
const commandArgs = tokens.slice(1);
const child = cp.spawn(command, commandArgs, { stdio: 'inherit', env: process.env });

const forward = (signal) => {
  try { child.kill(signal); } catch {}
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); } catch {}
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  const msg = error && error.message ? error.message : String(error);
  console.error(msg);
  process.exit(127);
});
`,
    );

    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevOverride = process.env.HAPPIER_OPENCODE_PATH;
    process.env.PATH = `${binDir}${delimiter}${dirname(process.execPath)}`;
    process.env.PATHEXT = '.CMD';
    delete process.env.HAPPIER_OPENCODE_PATH;
    try {
      await withPlatform('win32', async () => {
        const res = await probeAgentModelsBestEffort({
          agentId: 'opencode',
          cwd: fixture.dir,
          timeoutMs: CLI_MODELS_PROBE_TEST_TIMEOUT_MS,
        });
        expect(res.source).toBe('dynamic');
        expect(res.availableModels[0]).toEqual({ id: 'default', name: 'Default' });
        expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1')).toBe(true);
        expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1-mini')).toBe(true);
      });
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OPENCODE_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OPENCODE_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);

  it('returns dynamic model list from `auggie model list` output when available', async () => {
    const fixture = await createProbeTempDir('happier-cli-model-probe-auggie');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const auggiePath = resolve(join(binDir, 'auggie'));
    await writeExecutableScript(
      auggiePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "model" && args[1] === "list") {
  process.stdout.write(
    "Available models:\\n" +
    " - GPT-5 [gpt5]\\n" +
    "     OpenAI GPT-5 legacy\\n" +
    " - Claude Opus 4.6 [opus4.6]\\n" +
    "     Best for complex tasks\\n"
  );
  process.exit(0);
}
process.exit(1);
`,
    );

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_AUGGIE_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    delete process.env.HAPPIER_AUGGIE_PATH;
    try {
      const res = await probeAgentModelsBestEffort({
        agentId: 'auggie',
        cwd: fixture.dir,
        timeoutMs: CLI_MODELS_PROBE_TEST_TIMEOUT_MS,
      });
      expect(res.source).toBe('dynamic');
      expect(res.availableModels[0]).toEqual({ id: 'default', name: 'Default' });
      expect(res.availableModels.some((m) => m.id === 'gpt5' && m.name === 'GPT-5')).toBe(true);
      expect(res.availableModels.some((m) => m.id === 'opus4.6' && m.name === 'Claude Opus 4.6')).toBe(true);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_AUGGIE_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_AUGGIE_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);

  it('returns dynamic model list from Cursor `models` hyphen output when ACP probing falls back to the CLI command', async () => {
    const fixture = await createProbeTempDir('happier-cli-model-probe-cursor');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const cursorAgentPath = resolve(join(binDir, 'cursor-agent'));
    await writeExecutableScript(
      cursorAgentPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write(
    "Available models:\\n" +
    "composer-2.5 - Composer 2.5 (current) (default)\\n" +
    "composer-2.5-fast - Composer 2.5 Fast\\n" +
    "gpt-5.5 - GPT-5.5\\n"
  );
  process.exit(0);
}
process.exit(1);
`,
    );

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_CURSOR_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_CURSOR_PATH = cursorAgentPath;
    try {
      const res = await probeAgentModelsBestEffort({
        agentId: 'cursor',
        cwd: fixture.dir,
        timeoutMs: CLI_MODELS_PROBE_TEST_TIMEOUT_MS,
      });
      expect(res.source).toBe('dynamic');
      expect(res.availableModels[0]).toEqual({ id: 'default', name: 'Default' });
      expect(res.availableModels).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'composer-2.5',
          name: 'Composer 2.5',
          modelOptions: [expect.objectContaining({ id: 'fast' })],
        }),
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ]));
      expect(res.availableModels.some((model) => model.id === 'composer-2.5-fast')).toBe(false);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_CURSOR_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_CURSOR_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);

  it('falls back only to the default Codex model when dynamic probing is unavailable', async () => {
    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_CODEX_ACP_BIN;
    process.env.PATH = '';
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    try {
      const res = await probeAgentModelsBestEffort({
        agentId: 'codex',
        cwd: process.cwd(),
        timeoutMs: 500,
      });
      expect(res.source).toBe('static');
      expect(res.availableModels).toEqual([{ id: 'default', name: 'Default' }]);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_CODEX_ACP_BIN = prevOverride;
      } else {
        delete process.env.HAPPIER_CODEX_ACP_BIN;
      }
    }
  });
});
