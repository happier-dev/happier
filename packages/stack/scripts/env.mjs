import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvFilePruned, ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { resolveStackEnvPath } from './utils/paths/paths.mjs';
import { readTextOrEmpty } from './utils/fs/ops.mjs';

function resolveTargetEnvPath() {
  // If we're already running under a stack wrapper, respect it.
  const explicit = (process.env.HAPPY_STACKS_ENV_FILE ?? process.env.HAPPY_LOCAL_ENV_FILE ?? '').trim();
  if (explicit) return explicit;

  // Self-host default: no stacks knowledge required; persist in the main stack env file.
  return resolveStackEnvPath('main').envPath;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const helpText = [
    '[env] usage:',
    '  happys env set KEY=VALUE [KEY2=VALUE2...]',
    '  happys env unset KEY [KEY2...]',
    '  happys env get KEY',
    '  happys env list',
    '  happys env path',
    '',
    'defaults:',
    '  - If running under a stack wrapper (HAPPY_STACKS_ENV_FILE is set), edits that stack env file.',
    '  - Otherwise, edits the main stack env file (~/.happy/stacks/main/env).',
    '',
    'notes:',
    '  - Changes take effect on next stack/daemon start (restart to apply).',
  ].join('\n');

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys env set KEY=VALUE [KEY2=VALUE2...] | unset KEY [KEY2...] | get KEY | list | path [--json]',
      },
      text: helpText,
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const subcmd = (positionals[0] ?? '').trim() || 'help';
  const envPath = resolveTargetEnvPath();

  if (subcmd === 'help') {
    printResult({
      json,
      data: {
        usage: 'happys env set|unset|get|list|path [--json]',
      },
      text: helpText,
    });
    return;
  }

  if (subcmd === 'path') {
    printResult({
      json,
      data: { ok: true, envPath },
      text: envPath,
    });
    return;
  }

  const raw = await readTextOrEmpty(envPath);
  const parsed = parseEnvToObject(raw);

  if (subcmd === 'list') {
    const keys = Object.keys(parsed ?? {}).sort((a, b) => a.localeCompare(b));
    const text = [
      `[env] path: ${envPath}`,
      ...keys.map((k) => `${k}=${parsed[k] ?? ''}`),
    ].join('\n');
    printResult({ json, data: { ok: true, envPath, env: parsed }, text });
    return;
  }

  if (subcmd === 'get') {
    const key = (positionals[1] ?? '').trim();
    if (!key) {
      throw new Error('[env] usage: happys env get KEY');
    }
    const value = Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : null;
    printResult({
      json,
      data: { ok: true, envPath, key, value },
      text: value == null ? '' : String(value),
    });
    return;
  }

  if (subcmd === 'set') {
    const pairs = positionals.slice(1);
    if (!pairs.length) {
      throw new Error('[env] usage: happys env set KEY=VALUE [KEY2=VALUE2...]');
    }
    const updates = pairs.map((p) => {
      const idx = p.indexOf('=');
      if (idx <= 0) {
        throw new Error(`[env] set: expected KEY=VALUE, got: ${p}`);
      }
      const key = p.slice(0, idx).trim();
      const value = p.slice(idx + 1);
      if (!key) {
        throw new Error(`[env] set: invalid key in: ${p}`);
      }
      return { key, value };
    });
    await ensureEnvFileUpdated({ envPath, updates });
    const updatedKeys = updates.map((u) => u.key);
    printResult({
      json,
      data: { ok: true, envPath, updatedKeys },
      text: `[env] ok: set ${updatedKeys.join(', ')}\n[env] path: ${envPath}`,
    });
    return;
  }

  if (subcmd === 'unset' || subcmd === 'remove' || subcmd === 'rm') {
    const keys = positionals.slice(1).map((k) => k.trim()).filter(Boolean);
    if (!keys.length) {
      throw new Error('[env] usage: happys env unset KEY [KEY2...]');
    }
    await ensureEnvFilePruned({ envPath, removeKeys: keys });
    printResult({
      json,
      data: { ok: true, envPath, removedKeys: keys },
      text: `[env] ok: unset ${keys.join(', ')}\n[env] path: ${envPath}`,
    });
    return;
  }

  throw new Error(`[env] unknown subcommand: ${subcmd}\n[env] usage: happys env set|unset|get|list|path`);
}

main().catch((err) => {
  console.error('[env] failed:', err);
  process.exit(1);
});

