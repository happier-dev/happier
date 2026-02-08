import { runCapture } from '../proc/proc.mjs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function expandHomeQuick(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

async function isDir(p) {
  const s = String(p ?? '').trim();
  if (!s) return false;
  try {
    const st = await stat(s);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function globToRegExp(glob) {
  // Minimal glob support for our SwiftBar plugin filenames:
  // - `*` matches any chars
  // - `?` matches a single char
  const g = String(glob ?? '').trim();
  if (!g) return null;
  const esc = (ch) => String(ch).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  let out = '^';
  for (const ch of g) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += esc(ch);
  }
  out += '$';
  return new RegExp(out);
}

function parseBool(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isPluginEntry(entry) {
  return Boolean(entry?.isFile?.() || entry?.isSymbolicLink?.());
}

export async function resolveSwiftbarPluginsDir({ env = process.env } = {}) {
  const override = (env.HAPPIER_STACK_SWIFTBAR_PLUGINS_DIR ?? '').trim();
  if (override) {
    const allowNonDarwinOverride = parseBool(env.HAPPIER_STACK_SWIFTBAR_ALLOW_OVERRIDE_NON_DARWIN);
    if (process.platform !== 'darwin' && !allowNonDarwinOverride) {
      return null;
    }
    const dir = expandHomeQuick(override);
    return (await isDir(dir)) ? dir : null;
  }

  if (process.platform !== 'darwin') return null;
  try {
    const dir = (await runCapture('bash', [
      '-lc',
      'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -n "$DIR" && -d "$DIR" ]]; then echo "$DIR"; exit 0; fi; D="$HOME/Library/Application Support/SwiftBar/Plugins"; if [[ -d "$D" ]]; then echo "$D"; exit 0; fi; echo ""',
    ])).trim();
    return dir || null;
  } catch {
    return null;
  }
}

export async function detectSwiftbarPluginInstalled({ pluginsDir, patterns = null, env = process.env } = {}) {
  const dir = pluginsDir ?? (await resolveSwiftbarPluginsDir({ env }));
  if (!dir) return { pluginsDir: null, installed: false };

  const pats = Array.isArray(patterns) && patterns.length ? patterns : ['hstack.*.sh'];
  const regs = pats.map(globToRegExp).filter(Boolean);
  if (regs.length === 0) return { pluginsDir: dir, installed: false };

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!isPluginEntry(e)) continue;
      if (regs.some((r) => r.test(e.name))) {
        return { pluginsDir: dir, installed: true };
      }
    }
    return { pluginsDir: dir, installed: false };
  } catch {
    return { pluginsDir: dir, installed: false };
  }
}

export async function removeSwiftbarPlugins({ pluginsDir, patterns = null, env = process.env } = {}) {
  const dir = pluginsDir ?? (await resolveSwiftbarPluginsDir({ env }));
  if (!dir) return { ok: true, removed: false, pluginsDir: null };

  const pats = Array.isArray(patterns) && patterns.length ? patterns : ['hstack.*.sh'];
  const regs = pats.map(globToRegExp).filter(Boolean);
  if (regs.length === 0) return { ok: true, removed: false, pluginsDir: dir };

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let removed = false;
    for (const e of entries) {
      if (!isPluginEntry(e)) continue;
      if (!regs.some((r) => r.test(e.name))) continue;
      try {
        await unlink(join(dir, e.name));
        removed = true;
      } catch {
        // ignore per-file errors (best effort)
      }
    }
    return { ok: true, removed, pluginsDir: dir };
  } catch {
    return { ok: false, removed: false, pluginsDir: dir };
  }
}
