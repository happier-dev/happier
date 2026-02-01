import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { detectSeedableAuthSources } from './sources.mjs';
import { bold, cyan, dim, green } from '../ui/ansi.mjs';

/**
 * Decide how a PR review stack should authenticate.
 *
 * This deliberately does NOT offer "legacy ~/.happy" sources:
 * for production/remote Happy installs we cannot reliably seed local DB Account rows, so it leads to broken stacks.
 */
export async function decidePrAuthPlan({
  interactive = isTty(),
  seedAuthFlag = null,
  explicitFrom = '',
  defaultLoginNow = true,
} = {}) {
  if (seedAuthFlag === false) return { mode: 'login', loginNow: defaultLoginNow };
  if (seedAuthFlag === true) {
    // Caller must supply from; if not, pick best available.
    const sources = detectSeedableAuthSources();
    const from = explicitFrom || sources[0] || 'main';
    return { mode: 'seed', from, link: true };
  }
  if (explicitFrom) {
    return { mode: 'seed', from: explicitFrom, link: true };
  }

  const sources = detectSeedableAuthSources();
  if (!interactive) {
    // Non-interactive default: prefer seeding only if explicitly configured elsewhere.
    // setup-pr will handle its own defaults.
    return { mode: 'auto', sources };
  }

  // If there's nothing to reuse, don't ask a pointless question.
  if (!sources.length) {
    return { mode: 'login', loginNow: defaultLoginNow, reason: 'no_seed_sources' };
  }

  // Interactive prompt: keep it simple for reviewers.
  const choice = await withRl(async (rl) => {
    const opts = [];
    if (sources.length) {
      opts.push({
        label: `reuse existing auth (${cyan(sources.join(' / '))})`,
        value: 'seed',
      });
    }
    opts.push({
      label: defaultLoginNow ? `login now (${green('recommended')})` : 'login later',
      value: 'login',
    });
    return await promptSelect(rl, {
      title: `${bold('Authentication for this PR stack')}\n${dim('Choose whether to reuse existing credentials or do a fresh guided login.')}`,
      options: opts,
      defaultIndex: 0,
    });
  });

  if (choice === 'seed' && sources.length) {
    let from = sources[0];
    if (sources.length > 1) {
      from = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: `${bold('Which auth should we reuse?')}\n${dim('Pick the stack whose credentials should be shared into this PR stack.')}`,
          options: sources.map((s) => ({ label: s, value: s })),
          defaultIndex: 0,
        });
      });
    }
    const link = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: `${bold('Reuse mode')}\n${dim('Symlink stays up to date; copy is more isolated.')}`,
        options: [
          { label: `symlink (${green('recommended')}) — stays up to date`, value: true },
          { label: 'copy — more isolated per stack', value: false },
        ],
        defaultIndex: 0,
      });
    });
    return { mode: 'seed', from: String(from), link: Boolean(link) };
  }

  return { mode: 'login', loginNow: defaultLoginNow };
}

