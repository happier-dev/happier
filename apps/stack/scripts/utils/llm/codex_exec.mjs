import { run } from '../proc/proc.mjs';

export const CODEX_PERMISSION_MODES = /** @type {const} */ (['safe', 'full-auto', 'yolo']);

export function buildCodexExecArgs({ cd, permissionMode }) {
  const cwd = String(cd ?? '').trim();
  if (!cwd) throw new Error('[llm] codex: missing cd');

  const mode = String(permissionMode ?? '').trim() || 'full-auto';
  if (!CODEX_PERMISSION_MODES.includes(mode)) {
    throw new Error(`[llm] codex: invalid permission mode: ${mode}`);
  }

  const args = ['exec', '--cd', cwd];
  if (mode === 'safe') {
    args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request');
  } else if (mode === 'full-auto') {
    args.push('--full-auto');
  } else if (mode === 'yolo') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  // Read the prompt from stdin.
  args.push('-');
  return args;
}

function pickHereDocMarker(text) {
  const s = String(text ?? '');
  for (let i = 0; i < 50; i++) {
    const marker = `HS_CODEX_PROMPT_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    if (!s.includes(marker)) return marker;
  }
  return `HS_CODEX_PROMPT_${Date.now()}`;
}

export function buildCodexExecScript({ cd, permissionMode, promptText }) {
  const args = buildCodexExecArgs({ cd, permissionMode });
  const marker = pickHereDocMarker(promptText);
  const prompt = String(promptText ?? '').trimEnd();

  // Use `command` to avoid shell aliases and ensure the expected binary is used.
  const codexCmd = ['command', 'codex', ...args.map((a) => JSON.stringify(String(a)))].join(' ');

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `cat <<'${marker}' | ${codexCmd}`,
    prompt,
    marker,
    '',
  ].join('\n');
}

export async function runCodexExecHere({ cd, permissionMode, promptText, env }) {
  const args = buildCodexExecArgs({ cd, permissionMode });
  const input = String(promptText ?? '');
  await run('codex', args, { cwd: cd, env: env ?? process.env, input });
}

