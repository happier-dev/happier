import { detectInstalledLlmTools } from './tools.mjs';
import { buildCodexExecScript, CODEX_PERMISSION_MODES, runCodexExecHere } from './codex_exec.mjs';
import { canLaunchNewTerminal, launchScriptInNewTerminal } from '../ui/terminal_launcher.mjs';
import { clipboardAvailable, copyTextToClipboard } from '../ui/clipboard.mjs';
import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { banner, bullets, cmd as cmdFmt, sectionTitle } from '../ui/layout.mjs';
import { bold, cyan, dim, green, red, yellow } from '../ui/ansi.mjs';
import { run } from '../proc/proc.mjs';

function codexPermissionOptions() {
  return [
    { value: 'full-auto', label: `${green('recommended')} — full-auto (approvals on request + workspace sandbox)` },
    { value: 'safe', label: `safe — always ask on risky actions (workspace sandbox)` },
    { value: 'yolo', label: `${red('danger')} — run without approvals/sandbox (YOLO)` },
  ];
}

function shouldAsk(options) {
  return isTty() && options.length > 1;
}

function buildInteractiveLaunchScript({ toolCmd, cd, title, promptText }) {
  const t = String(title ?? 'Happy Stacks (LLM)').trim();
  const cwd = String(cd ?? '').trim();
  const cmd = String(toolCmd ?? '').trim();
  const prompt = String(promptText ?? '').trimEnd();
  if (!cwd) throw new Error('[llm] launch: missing cwd');
  if (!cmd) throw new Error('[llm] launch: missing toolCmd');

  const execLine = (() => {
    // Prefer providing the prompt directly when the CLI supports it.
    // - Claude Code: `claude "query"` starts an interactive session with an initial prompt.
    // - OpenCode: `opencode --prompt "..."` starts the TUI with an initial prompt.
    if (cmd === 'claude') return 'exec command claude "$HS_PROMPT"';
    if (cmd === 'opencode') return 'exec command opencode --prompt "$HS_PROMPT"';
    // Fallback: start the tool and ask the user to paste.
    return `exec command ${JSON.stringify(cmd)}`;
  })();

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(cwd)}`,
    '',
    `echo ${JSON.stringify(t)}`,
    'echo',
    'echo "Prompt:"',
    'echo "------------------------------------------------------------"',
    'HS_PROMPT="$(cat <<\'HS_PROMPT_EOF\'',
    prompt,
    'HS_PROMPT_EOF',
    ')"',
    'echo "$HS_PROMPT"',
    'echo "------------------------------------------------------------"',
    'echo',
    'if command -v pbcopy >/dev/null 2>&1; then',
    '  printf "%s" "$HS_PROMPT" | pbcopy',
    '  echo "Copied prompt to clipboard (pbcopy)."',
    'fi',
    'echo',
    'echo "Press Enter to start now, or Ctrl+C to cancel."',
    'read -r _',
    execLine,
    '',
  ].join('\n');
}

export async function launchLlmAssistant({
  rl: providedRl = null,
  title,
  subtitle,
  promptText,
  cwd,
  preferredToolId = '',
  env = process.env,
  allowRunHere = true,
  allowCopyOnly = true,
  defaultPermissionMode = 'full-auto',
}) {
  const prompt = String(promptText ?? '').trimEnd();
  const cd = String(cwd ?? '').trim();
  if (!prompt) return { ok: false, reason: 'empty prompt' };
  if (!cd) return { ok: false, reason: 'missing cwd' };

  const tools = await detectInstalledLlmTools();
  const terminalSupport = await canLaunchNewTerminal({ env });

  if (tools.length === 0) {
    return { ok: false, reason: 'no supported LLM CLI detected', terminalSupport };
  }

  const withMaybeRl = async (fn) => {
    if (providedRl) return await fn(providedRl);
    return await withRl(fn);
  };

  const chosenTool =
    tools.length === 1
      ? tools[0]
      : tools.find((t) => t.id === preferredToolId) ||
        (!isTty()
          ? tools.find((t) => t.id === 'codex') || tools[0]
          : await withMaybeRl(async (rl) => {
              const defaultIndex = Math.max(0, tools.findIndex((t) => t.id === 'codex'));
              const picked = await promptSelect(rl, {
                title:
                  `${bold('Pick an LLM CLI')}\n` +
                  `${dim('We will launch it with a pre-filled migration prompt so it can run the port and resolve conflicts.')}`,
                options: tools.map((t) => ({
                  value: t.id,
                  label: `${cyan(t.id)} — ${t.label}${t.note ? ` ${dim(`— ${t.note}`)}` : ''}`,
                })),
                defaultIndex,
              });
              return tools.find((t) => t.id === picked) || tools[0];
            }));

  const launchOptions = [];
  if (terminalSupport.ok) {
    launchOptions.push({ value: 'new-terminal', label: `${green('recommended')} — launch in a new terminal window` });
  }
  if (allowRunHere) {
    launchOptions.push({ value: 'here', label: `run in this terminal ${dim('(will take over this session)')}` });
  }
  if (allowCopyOnly) {
    launchOptions.push({ value: 'copy', label: `copy the prompt and run it yourself` });
  }

  const launchMode =
    launchOptions.length === 1
      ? launchOptions[0].value
      : !isTty()
        ? launchOptions[0].value
        : await withMaybeRl(async (rl) => {
            return await promptSelect(rl, {
              title: `${bold('How do you want to run the migration assistant?')}`,
              options: launchOptions,
              defaultIndex: 0,
            });
          });

  const permissionMode =
    chosenTool.id !== 'codex'
      ? null
      : CODEX_PERMISSION_MODES.length === 1 || !isTty()
        ? defaultPermissionMode
        : await withMaybeRl(async (rl) => {
            const opts = codexPermissionOptions();
            const v = await promptSelect(rl, {
              title:
                `${bold('LLM permissions')}\n` +
                `${dim('Choose how much autonomy the LLM should have while running commands to migrate + resolve conflicts.')}`,
              options: opts,
              defaultIndex: Math.max(0, opts.findIndex((o) => o.value === defaultPermissionMode)),
            });
            return String(v || defaultPermissionMode);
          });

  if (launchMode === 'copy') {
    return { ok: true, launched: false, mode: 'copy', tool: chosenTool.id, permissionMode, terminalSupport };
  }

  // Auto-exec path (Codex only for now).
  if (chosenTool.id === 'codex') {
    if (launchMode === 'here') {
      await runCodexExecHere({ cd, permissionMode: permissionMode || defaultPermissionMode, promptText: prompt, env });
      return { ok: true, launched: true, mode: 'here', tool: chosenTool.id, permissionMode, terminalSupport };
    }

    // new-terminal
    const script = buildCodexExecScript({ cd, permissionMode: permissionMode || defaultPermissionMode, promptText: prompt });
    const res = await launchScriptInNewTerminal({ scriptText: script, title: title || 'Happy Stacks migration (LLM)' });
    if (!res.ok) {
      return { ok: false, reason: res.reason || 'failed to launch terminal', terminalSupport };
    }
    return { ok: true, launched: true, mode: 'new-terminal', tool: chosenTool.id, permissionMode, terminalSupport };
  }

  // Interactive launch path (Claude/OpenCode/Aider/etc).
  // Best-effort: copy prompt to clipboard now; the terminal script will print it too.
  if (await clipboardAvailable()) {
    await copyTextToClipboard(prompt).catch(() => {});
  }

  if (launchMode === 'here') {
    // Print prompt and then start the CLI (interactive).
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner(title || 'LLM prompt', { subtitle: subtitle || 'Paste this into your LLM CLI to run the migration.' }));
    // eslint-disable-next-line no-console
    console.log(prompt);
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(dim(`Starting: ${chosenTool.cmd}`));

    if (chosenTool.cmd === 'claude') {
      // Claude Code supports starting interactive mode with an initial prompt:
      // `claude "query"`.
      await run('claude', [prompt], { cwd: cd, env: env ?? process.env, stdio: 'inherit' });
    } else if (chosenTool.cmd === 'opencode') {
      // OpenCode supports starting the TUI with an initial prompt:
      // `opencode --prompt "..."`.
      await run('opencode', ['--prompt', prompt], { cwd: cd, env: env ?? process.env, stdio: 'inherit' });
    } else {
      await run(chosenTool.cmd, [], { cwd: cd, env: env ?? process.env, stdio: 'inherit' });
    }
    return { ok: true, launched: true, mode: 'here', tool: chosenTool.id, permissionMode, terminalSupport };
  }

  // new-terminal
  const script = buildInteractiveLaunchScript({
    toolCmd: chosenTool.cmd,
    cd,
    title: title || `Happy Stacks (${chosenTool.id})`,
    promptText: prompt,
  });
  const res = await launchScriptInNewTerminal({ scriptText: script, title: title || `Happy Stacks (${chosenTool.id})` });
  if (!res.ok) {
    return { ok: false, reason: res.reason || 'failed to launch terminal', terminalSupport };
  }
  return { ok: true, launched: true, mode: 'new-terminal', tool: chosenTool.id, permissionMode, terminalSupport };
}

export async function printAndMaybeCopyPrompt({ promptText, copy = false }) {
  const prompt = String(promptText ?? '').trimEnd();
  // eslint-disable-next-line no-console
  console.log(prompt);
  if (!copy) return { ok: true, copied: false };
  if (!(await clipboardAvailable())) return { ok: true, copied: false };
  const res = await copyTextToClipboard(prompt);
  return { ok: true, copied: Boolean(res.ok) };
}

export function renderLlmHelpBlock({ title, subtitle, promptText, detectedTools, terminalSupport }) {
  const tools = Array.isArray(detectedTools) ? detectedTools : [];
  const lines = [];
  lines.push('');
  lines.push(banner(title || 'LLM help', { subtitle: subtitle || 'Copy/paste this into your LLM to drive the migration.' }));
  lines.push(promptText);
  if (tools.length) {
    lines.push('');
    lines.push(sectionTitle('Detected LLM CLIs'));
    lines.push(bullets(tools.map((t) => `- ${dim(t.id)}: ${t.label}${t.note ? ` ${dim(`— ${t.note}`)}` : ''}`)));
  } else {
    lines.push('');
    lines.push(dim('No supported LLM CLI detected. You can still paste the prompt into any LLM UI.'));
  }
  if (terminalSupport?.ok) {
    lines.push('');
    lines.push(dim(`Terminal launch: ${green('supported')}`));
  } else if (terminalSupport) {
    lines.push('');
    lines.push(dim(`Terminal launch: ${yellow('not available')} ${dim(`(${terminalSupport.reason || 'unknown'})`)}`));
  }
  lines.push('');
  return lines.join('\n');
}

