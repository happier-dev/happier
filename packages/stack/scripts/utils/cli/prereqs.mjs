import { commandExists } from '../proc/commands.mjs';

function formatMissingTool({ name, why, install }) {
  return [`- ${name}: ${why}`, ...(install?.length ? install.map((l) => `  ${l}`) : [])].join('\n');
}

export async function assertCliPrereqs({ git = false, yarn = false, codex = false, coderabbit = false, augment = false } = {}) {
  const missing = [];

  if (git) {
    const hasGit = await commandExists('git');
    if (!hasGit) {
      const install =
        process.platform === 'darwin'
          ? ['Install Xcode Command Line Tools: `xcode-select --install`', 'Or install Git via Homebrew: `brew install git`']
          : ['Install Git using your package manager (e.g. `apt install git`, `dnf install git`)'];
      missing.push({
        name: 'git',
        why: 'required for cloning + updating PR worktrees',
        install,
      });
    }
  }

  if (yarn) {
    const hasYarn = await commandExists('yarn');
    if (!hasYarn) {
      missing.push({
        name: 'yarn',
        why: 'required to install dependencies',
        install: [
          'Enable Corepack (recommended): `corepack enable`',
          'Or install Yarn: `npm install -g yarn`',
        ],
      });
    }
  }

  if (codex) {
    const hasCodex = await commandExists('codex');
    if (!hasCodex) {
      missing.push({
        name: 'codex',
        why: 'required to run Codex review',
        install: [
          'Install Codex CLI and ensure `codex` is on PATH',
          'If using a managed install, ensure your PATH includes the Codex binary',
        ],
      });
    }
  }

  if (coderabbit) {
    const hasCodeRabbit = await commandExists('coderabbit');
    if (!hasCodeRabbit) {
      missing.push({
        name: 'coderabbit',
        why: 'required to run CodeRabbit CLI review',
        install: [
          'Install CodeRabbit CLI: `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`',
          'Then authenticate: `coderabbit auth login`',
        ],
      });
    }
  }

  if (augment) {
    const hasAuggie = await commandExists('auggie');
    if (!hasAuggie) {
      missing.push({
        name: 'auggie',
        why: 'required to run Augment (Auggie) review',
        install: ['Install Auggie CLI: `npm install -g @augmentcode/auggie`', 'Then authenticate: `auggie login`'],
      });
    }
  }

  if (!missing.length) return;

  throw new Error(
    `[prereqs] missing required tools:\n` +
      `${missing.map(formatMissingTool).join('\n')}\n\n` +
      `[prereqs] After installing, re-run the command.`
  );
}
