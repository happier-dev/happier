import { describe, expect, it } from 'vitest';

import { claudeDirectSessionProviderOps } from '@/backends/claude/directSessions/providerOps';
import { codexDirectSessionProviderOps } from '@/backends/codex/directSessions/providerOps';
import { openCodeDirectSessionProviderOps } from '@/backends/opencode/directSessions/providerOps';

describe('direct-session provider process recognition', () => {
  it('recognizes Windows and Unix agent invocations', () => {
    expect(claudeDirectSessionProviderOps.matchesProviderProcess?.({ name: 'claude.exe' })).toBe(true);
    expect(claudeDirectSessionProviderOps.matchesProviderProcess?.({
      name: 'node.exe',
      cmd: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    })).toBe(true);
    expect(codexDirectSessionProviderOps.matchesProviderProcess?.({ name: 'node', cmd: 'node /usr/lib/node_modules/@openai/codex-linux/bin/codex.js' })).toBe(true);
    expect(codexDirectSessionProviderOps.matchesProviderProcess?.({ name: 'codex.cmd' })).toBe(true);
    expect(openCodeDirectSessionProviderOps.matchesProviderProcess?.({ name: 'opencode' })).toBe(true);
    // Runtime options before the script do not hide it.
    expect(claudeDirectSessionProviderOps.matchesProviderProcess?.({
      name: 'node',
      cmd: 'node --no-warnings --enable-source-maps /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    })).toBe(true);
  });

  it('does not mistake unrelated or editor-bundled binaries for agents', () => {
    expect(claudeDirectSessionProviderOps.matchesProviderProcess?.({ name: 'claudette' })).toBe(false);
    // The VS Code ChatGPT extension bundles a `codex` app-server outside any `bin` directory.
    expect(codexDirectSessionProviderOps.matchesProviderProcess?.({
      name: 'codex',
      cmd: '/home/dev/.vscode/extensions/openai.chatgpt/bin/linux-x86_64/codex app-server',
    })).toBe(false);
    expect(openCodeDirectSessionProviderOps.matchesProviderProcess?.({ name: 'bash', cmd: 'bash -c ls' })).toBe(false);
    // Arguments of unrelated commands are not executables.
    expect(claudeDirectSessionProviderOps.matchesProviderProcess?.({ name: 'grep', cmd: 'grep claude server.log' })).toBe(false);
    expect(codexDirectSessionProviderOps.matchesProviderProcess?.({ name: 'less', cmd: 'less /home/dev/.npm/@openai/codex-linux/README.md' })).toBe(false);
  });
});
