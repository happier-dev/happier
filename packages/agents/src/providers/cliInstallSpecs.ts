import type { AgentId } from '../types.js';

export type ProviderCliInstallPlatform = 'darwin' | 'linux' | 'win32';

export type ProviderCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  /**
   * Whether this command is expected to require admin privileges (e.g. Windows "Run as Administrator").
   */
  requiresAdmin?: boolean;
  /**
   * Optional human-readable note for UI/UX.
   */
  note?: string | null;
}>;

export type ProviderCliInstallSpec = Readonly<{
  id: AgentId;
  title: string;
  binaries: ReadonlyArray<string>;
  /**
   * Optional structured install recipes per platform.
   * When null/empty, the provider requires manual installation.
   */
  install:
    | Partial<Record<ProviderCliInstallPlatform, ReadonlyArray<ProviderCliInstallCommand>>>
    | null;
  docsUrl?: string | null;
}>;

function bashCurlPipe(url: string): ProviderCliInstallCommand {
  return { cmd: 'bash', args: ['-lc', `curl -fsSL ${url} | bash`] };
}

function npmGlobal(pkg: string): ProviderCliInstallCommand {
  return { cmd: 'npm', args: ['install', '-g', pkg] };
}

function powershellInstall(command: string): ProviderCliInstallCommand {
  return {
    cmd: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
  };
}

function cmdInstall(command: string, opts: Readonly<{ requiresAdmin?: boolean; note?: string | null }> = {}): ProviderCliInstallCommand {
  return {
    cmd: 'cmd.exe',
    args: ['/c', command],
    requiresAdmin: opts.requiresAdmin,
    note: opts.note ?? null,
  };
}

export const PROVIDER_CLI_INSTALL_SPECS: Readonly<Record<AgentId, ProviderCliInstallSpec>> = {
  claude: {
    id: 'claude',
    title: 'Claude Code CLI',
    binaries: ['claude'],
    docsUrl: 'https://claude.ai',
    install: {
      darwin: [bashCurlPipe('https://claude.ai/install.sh')],
      linux: [bashCurlPipe('https://claude.ai/install.sh')],
      win32: [powershellInstall('irm https://claude.ai/install.ps1 | iex')],
    },
  },
  codex: {
    id: 'codex',
    title: 'OpenAI Codex CLI',
    binaries: ['codex'],
    docsUrl: 'https://github.com/openai/codex',
    install: {
      darwin: [npmGlobal('@openai/codex')],
      linux: [npmGlobal('@openai/codex')],
      win32: [npmGlobal('@openai/codex')],
    },
  },
  gemini: {
    id: 'gemini',
    title: 'Google Gemini CLI',
    binaries: ['gemini'],
    docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
    install: {
      darwin: [npmGlobal('@google/gemini-cli')],
      linux: [npmGlobal('@google/gemini-cli')],
      win32: [npmGlobal('@google/gemini-cli')],
    },
  },
  opencode: {
    id: 'opencode',
    title: 'OpenCode CLI',
    binaries: ['opencode'],
    docsUrl: 'https://opencode.ai',
    install: {
      darwin: [bashCurlPipe('https://opencode.ai/install')],
      linux: [bashCurlPipe('https://opencode.ai/install')],
    },
  },
  auggie: {
    id: 'auggie',
    title: 'Auggie CLI',
    binaries: ['auggie'],
    docsUrl: 'https://augmentcode.com',
    install: {
      darwin: [npmGlobal('@augmentcode/auggie')],
      linux: [npmGlobal('@augmentcode/auggie')],
      win32: [npmGlobal('@augmentcode/auggie')],
    },
  },
  kilo: {
    id: 'kilo',
    title: 'Kilo CLI',
    binaries: ['kilo'],
    docsUrl: null,
    install: {
      darwin: [npmGlobal('@kilocode/cli')],
      linux: [npmGlobal('@kilocode/cli')],
      win32: [npmGlobal('@kilocode/cli')],
    },
  },
  kimi: {
    id: 'kimi',
    title: 'Kimi CLI',
    binaries: ['kimi'],
    docsUrl: 'https://code.kimi.com',
    install: {
      darwin: [bashCurlPipe('https://code.kimi.com/install.sh')],
      linux: [bashCurlPipe('https://code.kimi.com/install.sh')],
      win32: [powershellInstall('Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression')],
    },
  },
  qwen: {
    id: 'qwen',
    title: 'Qwen CLI',
    binaries: ['qwen'],
    docsUrl: null,
    install: {
      darwin: [bashCurlPipe('https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh')],
      linux: [bashCurlPipe('https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh')],
      win32: [
        cmdInstall(
          'curl -fsSL -o %TEMP%\\install-qwen.bat https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat && %TEMP%\\install-qwen.bat',
          { requiresAdmin: true, note: 'Run in an Administrator terminal.' },
        ),
      ],
    },
  },
  pi: {
    id: 'pi',
    title: 'Pi Coding Agent CLI',
    binaries: ['pi'],
    docsUrl: null,
    install: {
      darwin: [npmGlobal('@mariozechner/pi-coding-agent')],
      linux: [npmGlobal('@mariozechner/pi-coding-agent')],
      win32: [npmGlobal('@mariozechner/pi-coding-agent')],
    },
  },
  copilot: {
    id: 'copilot',
    title: 'GitHub Copilot CLI',
    binaries: ['copilot'],
    docsUrl: 'https://github.com/github/copilot-cli',
    install: {
      darwin: [npmGlobal('@github/copilot')],
      linux: [npmGlobal('@github/copilot')],
      win32: [npmGlobal('@github/copilot')],
    },
  },
} as const;

export function getProviderCliInstallSpec(id: AgentId): ProviderCliInstallSpec {
  return PROVIDER_CLI_INSTALL_SPECS[id];
}

