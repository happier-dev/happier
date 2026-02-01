import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { detectSeedableAuthSources } from './sources.mjs';
import { guidedStackAuthLoginNow, stackAuthCopyFrom } from './stack_guided_login.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

export function needsAuthSeed({ cliHomeDir, accountCount }) {
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const hasAccessKey = existsSync(accessKeyPath);
  const hasAccounts = typeof accountCount === 'number' ? accountCount > 0 : null;
  return !hasAccessKey || hasAccounts === false;
}

export async function maybeRunInteractiveStackAuthSetup({
  rootDir,
  env = process.env,
  stackName,
  cliHomeDir,
  accountCount,
  isInteractive = isTty(),
  autoSeedEnabled = false,
  beforeLogin = null,
} = {}) {
  if (!isInteractive) return { ok: true, skipped: true, reason: 'non_interactive' };
  if (autoSeedEnabled) return { ok: true, skipped: true, reason: 'auto_seed_enabled' };
  if (!needsAuthSeed({ cliHomeDir, accountCount })) return { ok: true, skipped: true, reason: 'already_initialized' };

  const sources = detectSeedableAuthSources().filter((s) => s && s !== stackName);
  const hasDevAuth = sources.includes('dev-auth');
  const hasMain = sources.includes('main');

  let choice = 'login';
  if (hasDevAuth || hasMain) {
    choice = await withRl(async (rl) => {
      const opts = [];
      if (hasDevAuth) {
        opts.push({ label: `reuse ${cyan('dev-auth')} (${green('recommended')}) — no re-login`, value: 'dev-auth' });
      }
      if (hasMain) {
        opts.push({ label: `reuse ${cyan('main')} — fast, but shares identity with main`, value: 'main' });
      }
      opts.push({ label: `login now — guided browser flow`, value: 'login' });
      return await promptSelect(rl, {
        title: `${bold('Authentication required')}\n${dim(
          `Stack ${cyan(stackName)} needs auth before the daemon can register a machine.`
        )}`,
        options: opts,
        defaultIndex: 0,
      });
    });
  }

  if (choice === 'login') {
    if (beforeLogin && typeof beforeLogin === 'function') {
      await beforeLogin();
    }
    await guidedStackAuthLoginNow({ rootDir, stackName, env });
    return { ok: true, skipped: false, mode: 'login' };
  }

  const from = String(choice);
  await stackAuthCopyFrom({ rootDir, stackName, fromStackName: from, env, link: true });
  return { ok: true, skipped: false, mode: 'seed', from, link: true };
}

