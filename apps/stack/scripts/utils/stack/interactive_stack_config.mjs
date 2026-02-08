import { prompt, promptSelect, promptWorktreeSource } from '../cli/wizard.mjs';
import { gitCapture, gitOk } from '../git/git.mjs';
import { parseGithubOwnerRepo } from '../git/worktrees.mjs';
import { getRepoDir } from '../paths/paths.mjs';
import { cyan, dim, green } from '../ui/ansi.mjs';
import { sectionTitle, warn } from '../ui/layout.mjs';
import { normalizeStackNameOrNull } from './names.mjs';

function wantsNo(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'n' || v === 'no' || v === '0' || v === 'false';
}

async function promptStackName({ rl } = {}) {
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const raw = (await rl.question(`${dim('Stack name')}: `)).trim();
    const normalized = normalizeStackNameOrNull(raw);
    if (!normalized) {
      // eslint-disable-next-line no-console
      console.log(warn('Invalid stack name. Use lowercase letters/numbers/hyphens (example: my-stack).'));
      continue;
    }
    if (normalized === 'main') {
      // eslint-disable-next-line no-console
      console.log(warn('Stack name "main" is reserved. Use the default stack without creating it.'));
      continue;
    }

    const trimmedLower = raw.trim().toLowerCase();
    if (normalized !== trimmedLower) {
      // eslint-disable-next-line no-console
      console.log(warn(`Normalized stack name to ${cyan(normalized)}.`));
    }
    return normalized;
  }
}

function parsePortOrNull(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: true, kind: 'empty', port: null };
  const token = trimmed.toLowerCase();
  if (token === 'ephemeral') return { ok: true, kind: 'ephemeral', port: null };
  if (!/^\d+$/.test(token)) return { ok: false, kind: 'invalid', port: null };
  const n = Number(token);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return { ok: false, kind: 'invalid', port: null };
  return { ok: true, kind: 'port', port: n };
}

async function promptPort({ rl, promptFn, label, defaultValue = '' } = {}) {
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await promptFn(rl, label, { defaultValue });
    const parsed = parsePortOrNull(raw);
    if (parsed.ok) return { raw, parsed };
    // eslint-disable-next-line no-console
    console.log(warn(`Invalid port: "${String(raw ?? '').trim()}". Enter a number (1-65535), or leave empty.`));
  }
}

function normalizeRemoteNameOrNull(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  // Remote names should be safe identifiers and should not be interpreted as flags by `git remote ...`.
  // Allow namespaced remotes (e.g. "team/upstream") while avoiding ambiguous path-like forms.
  if (!/^(?!.*\/\/)(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v)) return null;
  return v;
}

async function promptRemoteName({ rl, promptFn, label, defaultValue = '' } = {}) {
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await promptFn(rl, label, { defaultValue });
    const trimmed = String(raw ?? '').trim();
    const fallback = String(defaultValue ?? '').trim();
    const normalized = normalizeRemoteNameOrNull(trimmed === '' && fallback !== '' ? fallback : trimmed);
    if (normalized) return normalized;
    // eslint-disable-next-line no-console
    console.log(
      warn(
        `Invalid git remote name: "${String(raw ?? '').trim()}". Use letters/numbers/dot/underscore/hyphen/slash (example: upstream or team/upstream).`
      )
    );
  }
}

async function describeGitRemote({ repoDir, remote }) {
  const r = String(remote ?? '').trim();
  if (!repoDir || !r) return '';
  try {
    const url = (await gitCapture({ cwd: repoDir, args: ['remote', 'get-url', r] })).trim();
    if (!url) return '';
    const parsed = parseGithubOwnerRepo(url);
    return parsed ? `${parsed.owner}/${parsed.repo}` : url;
  } catch {
    return '';
  }
}

async function resolveDefaultCreateRemote({ repoDir }) {
  // Prefer upstream when present (clean PR history), else fall back to origin.
  if (await gitOk({ cwd: repoDir, args: ['remote', 'get-url', 'upstream'] })) return 'upstream';
  if (await gitOk({ cwd: repoDir, args: ['remote', 'get-url', 'origin'] })) return 'origin';
  return 'upstream';
}

export async function interactiveNew({ rootDir, rl, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptSelectFn = deps.promptSelect ?? promptSelect;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults };

  if (!out.stackName) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Create a stack'));
    // eslint-disable-next-line no-console
    console.log(dim('Stacks are isolated local environments (ports + dirs + DB + CLI home).'));
    out.stackName = await promptStackName({ rl });
  }
  if (!out.stackName) {
    throw new Error('[stack] stack name is required');
  }
  {
    const normalized = normalizeStackNameOrNull(out.stackName);
    if (!normalized) {
      throw new Error('[stack] stack name is invalid');
    }
    if (normalized === 'main') {
      throw new Error('[stack] stack name "main" is reserved');
    }
    out.stackName = normalized;
  }

  if (!out.serverComponent) {
    out.serverComponent = await promptSelectFn(rl, {
      title: `${sectionTitle('Server flavor')}\n${dim('Pick the backend this stack should run. You can switch later with `stack srv`.')}`,
      options: [
        { label: `happier-server-light (${green('recommended')}) — simplest local install (PG_Light via embedded PGlite)`, value: 'happier-server-light' },
        { label: `happier-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happier-server' },
      ],
      defaultIndex: 0,
    });
  }

  if (!out.port) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Ports'));
    // eslint-disable-next-line no-console
    console.log(dim('Tip: leaving this empty uses an ephemeral port (recommended for non-main stacks).'));
    // Accept "ephemeral" explicitly, and reprompt on invalid input.
    const { parsed } = await promptPort({
      rl,
      promptFn,
      label: `${dim('Port')} (empty = ephemeral; type 'ephemeral' to unpin): `,
      defaultValue: '',
    });
    out.port = parsed.port;
  }

  if (!out.createRemote) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(sectionTitle('Worktrees'));
    const mainDir = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
    const upstreamRepo = await describeGitRemote({ repoDir: mainDir, remote: 'upstream' });
    const originRepo = await describeGitRemote({ repoDir: mainDir, remote: 'origin' });
    const defaultRemote = await resolveDefaultCreateRemote({ repoDir: mainDir });

    // eslint-disable-next-line no-console
    console.log(
      dim(`New worktrees are typically based on ${cyan('upstream')}${upstreamRepo ? ` (${upstreamRepo})` : ''} (clean PR history).`)
    );
    if (upstreamRepo || originRepo) {
      // eslint-disable-next-line no-console
      console.log(dim(`Remotes: ${upstreamRepo ? `upstream=${upstreamRepo}` : 'upstream=(missing)'}, ${originRepo ? `origin=${originRepo}` : 'origin=(missing)'}`));
    }

    out.createRemote = await promptRemoteName({
      rl,
      promptFn,
      label: `${dim('Git remote for new worktrees')} (default: ${defaultRemote}): `,
      defaultValue: defaultRemote,
    });
  }

  if (out.repo == null) {
    // NOTE: promptWorktreeSource is still component-named internally; for hstack, this is the monorepo checkout.
    out.repo = await promptWorktreeSourceFn({
      rl,
      rootDir,
      component: 'happier-ui',
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}

export async function interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults, deps = {} }) {
  const promptFn = deps.prompt ?? prompt;
  const promptSelectFn = deps.promptSelect ?? promptSelect;
  const promptWorktreeSourceFn = deps.promptWorktreeSource ?? promptWorktreeSource;

  const out = { ...defaults, stackName };

  const currentServer = existingEnv.HAPPIER_STACK_SERVER_COMPONENT ?? '';
  out.serverComponent = await promptSelectFn(rl, {
    title: `${sectionTitle('Server flavor')}\n${dim('Pick the backend this stack should run. You can switch again later.')}`,
    options: [
      { label: `happier-server-light (${green('recommended')}) — simplest local install (PG_Light via embedded PGlite)`, value: 'happier-server-light' },
      { label: `happier-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happier-server' },
    ],
    defaultIndex: (currentServer || 'happier-server-light') === 'happier-server' ? 1 : 0,
  });

  const currentPort = existingEnv.HAPPIER_STACK_SERVER_PORT ?? '';
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(sectionTitle('Ports'));
  const { parsed } = await promptPort({
    rl,
    promptFn,
    label: `${dim(`Port`)} (empty = keep ${currentPort || 'ephemeral'}; type 'ephemeral' to unpin): `,
    defaultValue: '',
  });
  const existingPort = currentPort ? Number(currentPort) : null;
  out.port = parsed.kind === 'empty' ? (Number.isFinite(existingPort) ? existingPort : null) : parsed.port;

  const currentRemote = existingEnv.HAPPIER_STACK_STACK_REMOTE ?? '';
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(sectionTitle('Worktrees'));
  const mainDir = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
  const upstreamRepo = await describeGitRemote({ repoDir: mainDir, remote: 'upstream' });
  const originRepo = await describeGitRemote({ repoDir: mainDir, remote: 'origin' });
  if (upstreamRepo || originRepo) {
    // eslint-disable-next-line no-console
    console.log(dim(`Remotes: ${upstreamRepo ? `upstream=${upstreamRepo}` : 'upstream=(missing)'}, ${originRepo ? `origin=${originRepo}` : 'origin=(missing)'}`));
  }
  const defaultRemote = (currentRemote || (await resolveDefaultCreateRemote({ repoDir: mainDir })) || 'upstream').trim();
  out.createRemote = await promptRemoteName({
    rl,
    promptFn,
    label: `${dim('Git remote for new worktrees')} (default: ${defaultRemote}): `,
    defaultValue: defaultRemote,
  });

  out.repo = await promptWorktreeSourceFn({
    rl,
    rootDir,
    component: 'happier-ui',
    stackName,
    createRemote: out.createRemote,
  });

  return out;
}
