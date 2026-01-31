import { runCapture } from '../proc/proc.mjs';

export async function resolveSwiftbarPluginsDir() {
  if (process.platform !== 'darwin') {
    return null;
  }
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

export async function detectSwiftbarPluginInstalled({ pluginsDir, patterns = null } = {}) {
  if (process.platform !== 'darwin') return { pluginsDir: null, installed: false };
  const dir = pluginsDir ?? (await resolveSwiftbarPluginsDir());
  if (!dir) return { pluginsDir: null, installed: false };

  const pats = Array.isArray(patterns) && patterns.length ? patterns : ['happy-stacks.*.sh', 'happy-local.*.sh'];
  const expr = pats.map((p) => `ls -1 "${dir}"/${p} 2>/dev/null | head -n 1 || true`).join('; ');
  try {
    const hit = (await runCapture('bash', ['-lc', expr])).trim();
    return { pluginsDir: dir, installed: Boolean(hit) };
  } catch {
    return { pluginsDir: dir, installed: false };
  }
}

export async function removeSwiftbarPlugins({ patterns = null } = {}) {
  if (process.platform !== 'darwin') {
    return { ok: true, removed: false, pluginsDir: null };
  }
  const dir = await resolveSwiftbarPluginsDir();
  if (!dir) {
    return { ok: true, removed: false, pluginsDir: null };
  }

  const pats = Array.isArray(patterns) && patterns.length ? patterns : ['happy-stacks.*.sh', 'happy-local.*.sh'];
  const rmExpr = pats.map((p) => `rm -f "${dir}"/${p} 2>/dev/null || true`).join('; ');
  try {
    await runCapture('bash', ['-lc', rmExpr]);
    return { ok: true, removed: true, pluginsDir: dir };
  } catch {
    return { ok: false, removed: false, pluginsDir: dir };
  }
}

