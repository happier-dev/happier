import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

async function mergeCopyDir({ srcDir, destDir }) {
  if (!existsSync(srcDir)) return;
  await mkdir(destDir, { recursive: true });
  await cp(srcDir, destDir, { recursive: true, force: false, errorOnExist: false });
}

async function copyFileIfNewer({ srcFile, destFile }) {
  if (!existsSync(srcFile)) return;
  try {
    const srcStat = await stat(srcFile);
    let destStat = null;
    try {
      destStat = await stat(destFile);
    } catch {
      destStat = null;
    }
    if (!destStat || srcStat.mtimeMs > destStat.mtimeMs) {
      await mkdir(join(destFile, '..'), { recursive: true });
      await copyFile(srcFile, destFile);
    }
  } catch {
    // best-effort
  }
}

/**
 * Best-effort: seed CodeRabbit auth/config into an isolated home directory.
 *
 * We do not read or print any auth contents; we only copy the on-disk state when present.
 */
export async function seedCodeRabbitHomeFromRealHome({ realHomeDir, isolatedHomeDir } = {}) {
  const real = String(realHomeDir ?? '').trim();
  const isolated = String(isolatedHomeDir ?? '').trim();
  if (!real || !isolated || real === isolated) return;

  // Common CodeRabbit state locations:
  // - ~/.coderabbit/
  // - ~/.config/coderabbit/ (XDG config)
  // - ~/.cache/coderabbit/ (XDG cache)
  // - ~/.local/share/coderabbit/ (XDG data)
  // - ~/.local/state/coderabbit/ (XDG state)
  //
  // We merge-copy without overwriting existing files so a user can explicitly
  // auth in the isolated dir and we won't clobber it.
  await mergeCopyDir({ srcDir: join(real, '.coderabbit'), destDir: join(isolated, '.coderabbit') });
  await mergeCopyDir({ srcDir: join(real, '.config', 'coderabbit'), destDir: join(isolated, '.config', 'coderabbit') });
  await mergeCopyDir({ srcDir: join(real, '.cache', 'coderabbit'), destDir: join(isolated, '.cache', 'coderabbit') });
  await mergeCopyDir({ srcDir: join(real, '.local', 'share', 'coderabbit'), destDir: join(isolated, '.local', 'share', 'coderabbit') });
  await mergeCopyDir({ srcDir: join(real, '.local', 'state', 'coderabbit'), destDir: join(isolated, '.local', 'state', 'coderabbit') });

  // If the user re-authenticated recently, refresh auth.json even when it already exists.
  await copyFileIfNewer({
    srcFile: join(real, '.coderabbit', 'auth.json'),
    destFile: join(isolated, '.coderabbit', 'auth.json'),
  });
}

/**
 * Best-effort: seed Codex auth/config into an isolated CODEX_HOME directory.
 *
 * Codex stores auth/config under `CODEX_HOME` (default: ~/.codex). In stack review runs we
 * use a per-repo isolated home (e.g. .project/codex-home) to avoid polluting ~/.codex and
 * to keep sandboxed runs self-contained.
 *
 * We do not read or print any auth contents; we only copy the on-disk state when present.
 */
export async function seedCodexHomeFromRealHome({ realHomeDir, isolatedHomeDir } = {}) {
  const real = String(realHomeDir ?? '').trim();
  const isolated = String(isolatedHomeDir ?? '').trim();
  if (!real || !isolated || real === isolated) return;

  // Codex uses CODEX_HOME/{auth.json,config.toml,...}
  await copyFileIfNewer({ srcFile: join(real, '.codex', 'auth.json'), destFile: join(isolated, 'auth.json') });
  await copyFileIfNewer({ srcFile: join(real, '.codex', 'config.toml'), destFile: join(isolated, 'config.toml') });
}

/**
 * Best-effort: seed Auggie (Augment CLI) auth/config into an isolated cache directory.
 *
 * Auggie uses `~/.augment` by default (see `--augment-cache-dir`), and supports
 * providing session auth via `AUGMENT_SESSION_AUTH` (same format as `~/.augment/session.json`).
 *
 * We do not read or print any auth contents; we only copy the on-disk state when present.
 */
export async function seedAugmentHomeFromRealHome({ realHomeDir, isolatedHomeDir } = {}) {
  const real = String(realHomeDir ?? '').trim();
  const isolated = String(isolatedHomeDir ?? '').trim();
  if (!real || !isolated || real === isolated) return;

  // Copy ~/.augment/* into the isolated cache dir.
  await mergeCopyDir({ srcDir: join(real, '.augment'), destDir: isolated });

  // Refresh session.json when it is newer.
  await copyFileIfNewer({ srcFile: join(real, '.augment', 'session.json'), destFile: join(isolated, 'session.json') });
}
