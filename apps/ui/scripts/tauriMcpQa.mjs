#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareTauriSidecar } from './prepareTauriSidecar.mjs';
import { buildStackTauriDevConfig, resolveStackTauriDevUrl } from '../../stack/scripts/utils/tauri/dev_runtime.mjs';
import { buildStackTauriDevProcessInvocation } from '../../stack/scripts/utils/dev/tauri_dev.mjs';
import { waitForExpoMetroRunning } from '../../stack/scripts/utils/expo/expo.mjs';
import { getRootDir } from '../../stack/scripts/utils/paths/paths.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from '../../stack/scripts/utils/stack/runtime_state.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const repoRoot = getRootDir(import.meta.url);

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function nextLineBreakIndex(text) {
  const lineFeedIndex = text.indexOf('\n');
  const carriageReturnIndex = text.indexOf('\r');
  if (lineFeedIndex < 0) return carriageReturnIndex;
  if (carriageReturnIndex < 0) return lineFeedIndex;
  return Math.min(lineFeedIndex, carriageReturnIndex);
}

function consumeLineBreak(text) {
  if (text.startsWith('\r\n')) return text.slice(2);
  if (text.startsWith('\n') || text.startsWith('\r')) return text.slice(1);
  return text;
}

function writePrefixed(stream, prefix, state, chunk) {
  state.buffer += chunk.toString();
  while (true) {
    const lineBreakIndex = nextLineBreakIndex(state.buffer);
    if (lineBreakIndex < 0) break;
    const line = state.buffer.slice(0, lineBreakIndex);
    state.buffer = consumeLineBreak(state.buffer.slice(lineBreakIndex));
    stream.write(`${prefix}${line}\n`);
  }
}

function flushPrefixed(stream, prefix, state) {
  if (!state.buffer) return;
  stream.write(`${prefix}${state.buffer}\n`);
  state.buffer = '';
}

function spawnLoggedProcess({ label, command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  const stdoutState = { buffer: '' };
  const stderrState = { buffer: '' };
  const prefix = `[${label}] `;
  child.stdout?.on('data', (chunk) => writePrefixed(process.stdout, prefix, stdoutState, chunk));
  child.stderr?.on('data', (chunk) => writePrefixed(process.stderr, prefix, stderrState, chunk));
  child.on('close', () => {
    flushPrefixed(process.stdout, prefix, stdoutState);
    flushPrefixed(process.stderr, prefix, stderrState);
  });

  return child;
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null || !child.pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function wantsWaitForExpo(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_TAURI_WAIT_FOR_EXPO ?? '').trim();
  if (raw) return raw !== '0';
  return true;
}

function parsePortFromUrl(rawUrl, fallbackPort) {
  try {
    const url = new URL(String(rawUrl ?? '').trim());
    const p = Number(url.port || fallbackPort);
    return Number.isFinite(p) && p > 0 ? Math.floor(p) : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

export function createTauriMcpQaExitTracker() {
  const exited = { tauri: null, mcp: null };
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

  function resolveSignalExitCode(signal) {
    const s = typeof signal === 'string' ? signal : '';
    return s ? (signalExitCodes[s] ?? 1) : null;
  }

  function record(kind, code, signal) {
    if (exited[kind] != null) return;
    exited[kind] = { code, signal };
  }

  return {
    onChildExit(kind, code, signal) {
      const key = kind === 'mcp' ? 'mcp' : 'tauri';
      const resolvedSignalExit = resolveSignalExitCode(signal);
      record(key, code ?? 0, signal ?? null);
      if (resolvedSignalExit != null) {
        return resolvedSignalExit;
      }
      const resolvedCode = Number.isFinite(Number(code)) ? Number(code) : 0;
      if (resolvedCode !== 0) {
        return resolvedCode;
      }
      if (exited.tauri && exited.mcp) {
        return 0;
      }
      return null;
    },
    onChildError() {
      return 1;
    },
  };
}

export async function resolveTauriMcpQaPlan({ env = process.env } = {}) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim();
  const runtimeState = stackName ? await readStackRuntimeStateFile(getStackRuntimeStatePath(stackName)) : null;
  const defaultPort = Number(env.HAPPIER_STACK_TAURI_DEV_PORT ?? 8081);
  const devUrl = resolveStackTauriDevUrl({ runtimeState, defaultPort });
  const baseConfig = await readJsonFile(join(packageRoot, 'src-tauri', 'tauri.conf.json'));
  const overlayConfig = await readJsonFile(join(packageRoot, 'src-tauri', 'tauri.publicdev.conf.json'));
  const configPath = join(packageRoot, 'src-tauri', 'tauri.conf.json');
  const tauriConfig = buildStackTauriDevConfig({ baseConfig, overlayConfig, devUrl, env });
  const tauriDev = buildStackTauriDevProcessInvocation({
    rootDir: repoRoot,
    env,
    configPath,
    configOverride: tauriConfig,
  });

  return {
    cwd: packageRoot,
    devUrl,
    configPath,
    tauriConfig,
    tauriDev,
    mcpServer: {
      command: 'npx',
      args: ['-y', '@hypothesi/tauri-mcp-server'],
    },
  };
}

function printUsage() {
  return [
    '[tauri-qa] usage:',
    '  node ./apps/ui/scripts/tauriMcpQa.mjs',
    '',
    'options:',
    '  --json   Print the resolved launch plan without starting processes',
    '',
    'starts:',
    '  - the stack-owned Tauri dev app',
    '  - the MCP server used by Codex/manual QA',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');

  if (help) {
    process.stdout.write(printUsage() + '\n');
    return;
  }

  const plan = await resolveTauriMcpQaPlan();
  if (json) {
    const { tauriConfig: _tauriConfig, tauriDev, ...preview } = plan;
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          plan: {
            ...preview,
            tauriDev: {
              command: tauriDev.command,
              args: tauriDev.args,
              cwd: tauriDev.cwd,
            },
          },
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (wantsWaitForExpo(process.env)) {
    const defaultPort = Number(process.env.HAPPIER_STACK_TAURI_DEV_PORT ?? 8081);
    const fallbackPort = Number.isFinite(defaultPort) && defaultPort > 0 ? defaultPort : 8081;
    const expoPort = parsePortFromUrl(plan.devUrl, fallbackPort);
    const metro = await waitForExpoMetroRunning({ port: expoPort, env: process.env });
    if (!metro.ok) {
      throw new Error(
        [
          `[tauri-qa] Expo dev server was not reachable on port ${expoPort}.`,
          'Start the UI dev server first (`yarn ui`, `yarn --cwd apps/ui start`, or `yarn tui:with-tauri`) and retry.',
        ].join(' ')
      );
    }
  }

  await prepareTauriSidecar({ env: process.env });

  const children = [];
  const stopChildren = (signal = 'SIGTERM') => {
    for (const child of children) {
      killProcessTree(child, signal);
    }
  };

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      stopChildren(signal);
    };
    process.on(signal, handler);
    signalHandlers.set(signal, handler);
  }

  const cleanup = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const tauriDev = spawnLoggedProcess({
    label: 'tauri',
    command: plan.tauriDev.command,
    args: plan.tauriDev.args,
    cwd: plan.tauriDev.cwd ?? plan.cwd,
    env: plan.tauriDev.env ?? process.env,
  });
  const mcpServer = spawnLoggedProcess({
    label: 'tauri-mcp',
    command: plan.mcpServer.command,
    args: plan.mcpServer.args,
    cwd: plan.cwd,
    env: process.env,
  });
  children.push(tauriDev, mcpServer);

  const tracker = createTauriMcpQaExitTracker();
  const exitState = await new Promise((resolve) => {
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      stopChildren(signal ?? 'SIGTERM');
      resolve({ code, signal });
    };

    tauriDev.once('error', (error) => {
      process.stderr.write(`[tauri] ${error instanceof Error ? error.message : String(error)}\n`);
      settle(tracker.onChildError('tauri', error), null);
    });
    mcpServer.once('error', (error) => {
      process.stderr.write(`[tauri-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
      settle(tracker.onChildError('mcp', error), null);
    });

    tauriDev.once('exit', (code, signal) => {
      const out = tracker.onChildExit('tauri', code ?? 0, signal ?? null);
      if (out != null) settle(out, signal ?? null);
    });
    mcpServer.once('exit', (code, signal) => {
      const out = tracker.onChildExit('mcp', code ?? 0, signal ?? null);
      if (out != null) settle(out, signal ?? null);
    });
  });

  process.exit(exitState.code ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[tauri-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
