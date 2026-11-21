const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

function safeAppendJsonl(filePath, obj) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch {
    // Best-effort diagnostics only.
  }
}

function fakeClaudeEchoResponseText(promptText) {
  const promptHash = createHash('sha256').update(String(promptText)).digest('hex').slice(0, 16);
  return fakeClaudeEchoResponseTextFromSha256(promptHash);
}

function fakeClaudeEchoResponseTextFromSha256(promptSha256) {
  return `FAKE_CLAUDE_ECHO_${String(promptSha256).slice(0, 16)}`;
}

function parseMcpConfigs(argv, readMaterializedConfig = false) {
  const configs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw;
    if (arg === '--mcp-config') {
      raw = argv[++i];
    } else if (arg.startsWith('--mcp-config=')) {
      raw = arg.slice('--mcp-config='.length);
    }
    if (raw === undefined) continue;
    try {
      const json = readMaterializedConfig && path.isAbsolute(raw) ? fs.readFileSync(raw, 'utf8') : raw;
      configs.push(JSON.parse(json));
    } catch {
      configs.push({ _parseError: true, raw });
    }
  }
  return configs;
}

function mergeMcpServers(configs) {
  const merged = {};
  for (const cfg of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : null;
    if (!servers) continue;
    for (const [name, value] of Object.entries(servers)) {
      merged[name] = value;
    }
  }
  return merged;
}

function findArgValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const value = argv[i + 1];
      if (typeof value === 'string') return value;
      return null;
    }
  }
  return null;
}

// Recognize only the generated argv shape. Never hand the configured command to a shell.
function generatedSessionStartPattern(word) {
  return new RegExp(`^${word} ${word} '(\\d+)' 'SessionStart'(?: '--secret-file' ${word})?$`);
}

const posixSessionStartPattern = generatedSessionStartPattern(String.raw`'((?:[^'\0]|'\\'')+)'`);
const powerShellSessionStartPattern = generatedSessionStartPattern(String.raw`'((?:[^'\0]|'')+)'`);
const encodedPowerShellPattern = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/;

function parseHookCommandString(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;

  const encodedPowerShell = cmd.match(encodedPowerShellPattern)?.[1];
  const powerShell = encodedPowerShell && Buffer.from(encodedPowerShell, 'base64').toString('utf16le');
  const generated = powerShell?.startsWith('& ')
    ? powerShell.slice(2).match(powerShellSessionStartPattern)
    : cmd.match(posixSessionStartPattern);
  if (generated) {
    const [, runtime, script, port, secret] = generated;
    const escapedQuote = powerShell ? "''" : String.raw`'\''`;
    return {
      type: 'node',
      runtimeExecutable: runtime.replaceAll(escapedQuote, "'"),
      scriptPath: script.replaceAll(escapedQuote, "'"),
      port: Number(port),
      hookEventName: 'SessionStart',
      ...(secret ? { secretFile: secret.replaceAll(escapedQuote, "'") } : {}),
    };
  }

  // Historical fixture settings used double quotes and an optional hook event.
  const legacy = cmd.match(/^(node|"([^"]+)")\s+"([^"]+)"\s+(\d+)(?:\s+"([^"]+)")?(?:\s+--secret-file\s+"([^"]+)")?\s*$/);
  if (!legacy) return { type: 'raw', command: cmd };
  const [, , runtime, scriptPath, port, hookEventName, secretFile] = legacy;
  return {
    type: 'node',
    runtimeExecutable: runtime ?? 'node',
    scriptPath,
    port: Number(port),
    ...(hookEventName ? { hookEventName } : {}),
    ...(secretFile ? { secretFile } : {}),
  };
}

function parseHookForwarderCommandFromFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    const cmd = json?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    return parseHookCommandString(cmd);
  } catch {
    return null;
  }
}

function parseHookForwarderCommand(argv) {
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] !== '--plugin-dir') continue;
    const pluginDir = argv[index + 1];
    if (!pluginDir || pluginDir.startsWith('--')) continue;
    const hook = parseHookForwarderCommandFromFile(path.join(pluginDir, 'hooks', 'hooks.json'));
    if (hook) return hook;
    index++;
  }
  return parseHookForwarderCommandFromFile(findArgValue(argv, '--settings'));
}

async function runHookForwarder(params) {
  const { hook, payload, logPath, invocationId, spawnImpl = spawn } = params;
  if (!hook) return;
  if (hook.type === 'node' && hook.scriptPath && Number.isFinite(hook.port)) {
    await new Promise((resolve) => {
      const args = [hook.scriptPath, String(hook.port)];
      if (typeof hook.hookEventName === 'string' && hook.hookEventName.length > 0) {
        args.push(hook.hookEventName);
      }
      if (typeof hook.secretFile === 'string' && hook.secretFile.length > 0) {
        args.push('--secret-file', hook.secretFile);
      }
      const child = spawnImpl(hook.runtimeExecutable || 'node', args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: process.env,
      });
      child.on('error', (error) => {
        safeAppendJsonl(logPath, {
          type: 'hook_forwarder_error',
          invocationId,
          ts: Date.now(),
          message: error instanceof Error ? error.message : String(error),
        });
        resolve();
      });
      child.on('exit', (code, signal) => {
        if (code !== 0) {
          safeAppendJsonl(logPath, {
            type: 'hook_forwarder_nonzero_exit',
            invocationId,
            ts: Date.now(),
            code,
            signal,
          });
        }
        resolve();
      });
      try {
        child.stdin.write(JSON.stringify(payload));
      } catch (error) {
        safeAppendJsonl(logPath, {
          type: 'hook_forwarder_stdin_write_error',
          invocationId,
          ts: Date.now(),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        child.stdin.end();
      } catch (error) {
        safeAppendJsonl(logPath, {
          type: 'hook_forwarder_stdin_end_error',
          invocationId,
          ts: Date.now(),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return;
  }

  if (hook.type === 'raw' && hook.command) {
    // Safety: never execute unparsed hook commands by default.
    safeAppendJsonl(logPath, {
      type: 'hook_skipped',
      invocationId,
      ts: Date.now(),
      reason: 'unparseable_command',
      command: hook.command,
    });
  }
}

module.exports = {
  fakeClaudeEchoResponseText,
  fakeClaudeEchoResponseTextFromSha256,
  findArgValue,
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
  safeAppendJsonl,
};
