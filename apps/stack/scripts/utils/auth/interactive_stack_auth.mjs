import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { detectSeedableAuthSources } from './sources.mjs';
import { stackAuthCopyFrom } from './stack_guided_login.mjs';
import { runOrchestratedGuidedAuthFlow } from './orchestrated_stack_auth_flow.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';
import { findAnyCredentialPathInCliHome } from './credentials_paths.mjs';

export function needsAuthSeed({ cliHomeDir, accountCount }) {
  const hasAccessKey = Boolean(findAnyCredentialPathInCliHome({ cliHomeDir }));
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
    await runOrchestratedGuidedAuthFlow({
      rootDir,
      stackName,
      env,
      verbosity: 0,
      json: false,
    });
    return { ok: true, skipped: false, mode: 'login' };
  }

  const from = String(choice);
  await stackAuthCopyFrom({ rootDir, stackName, fromStackName: from, env, link: true });
  return { ok: true, skipped: false, mode: 'seed', from, link: true };
}
