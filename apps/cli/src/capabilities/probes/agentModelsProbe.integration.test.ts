import { describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { probeAgentModelsBestEffort, probeModelsFromAcpBackend } from './agentModelsProbe';
import {
  createProbeTempDir,
  resolveAcpSdkEntryFromCwd,
  writeExecutableScript,
  writeFakeAcpAgentScript,
} from './agentModelsProbe.testkit';

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

function createApprovedPermissionHandler(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
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
          id: "model",
          name: "Model",
          type: "enum",
          currentValue: "model-a",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
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
    } finally {
      await backend.dispose().catch(() => {});
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
      const res = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 750 });
      expect(res.source).toBe('dynamic');
      expect(res.availableModels[0]).toEqual({ id: 'default', name: 'Default' });
      expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1')).toBe(true);
      expect(res.availableModels.some((m) => m.id === 'openai/gpt-4.1-mini')).toBe(true);
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
if (args[0] === "models") {
  process.stdout.write("openai/gpt-4.1\\nopenai/gpt-4.1-mini\\n");
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
        const res = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 2_000 });
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
      const res = await probeAgentModelsBestEffort({ agentId: 'auggie', cwd: fixture.dir, timeoutMs: 750 });
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
});
