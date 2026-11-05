import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Recognize the CLI's complete workspace resolver and configs that retain it.
 * Partial/plugin-replacing configs and unknown setup expressions keep runtime
 * preparation. Read declarations only; loading Vitest would run global setup. */
export function readVitestSourcePreparation(repoRoot, configPath, isKnownSourceConfig) {
  const cliSourceResolver = resolve(repoRoot, 'apps/cli/scripts/vitestWorkspacePackageResolution.ts');
  const visited = new Set();
  const read = (path) => {
    if (isKnownSourceConfig(path)) return { buildsDist: false };
    if (visited.has(path)) return null;
    visited.add(path);
    let source;
    try { source = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const hasPlugins = /\bplugins\s*:/u.test(source);
    const resolverImport = /import\s*\{[^}]*\bworkspacePackageSourcesPlugin\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/u.exec(source);
    const directResolver = resolverImport
      && resolve(dirname(path), resolverImport[1].replace(/\.ts$/u, '') + '.ts') === cliSourceResolver
      && /\bplugins\s*:\s*\[\s*workspacePackageSourcesPlugin\s*[,\]]/u.test(source);
    let inherited;
    if (!directResolver) {
      for (const match of source.matchAll(/import\s+(\w+)\s+from\s+['"]((?:\.\.?\/)[^'"]*vitest(?:\.[\w-]+)*\.config)(?:\.ts)?['"]/gu)) {
        if (!new RegExp(`\\.\\.\\.${match[1]}\\s*[,}]`, 'u').test(source)) continue;
        if (hasPlugins && !new RegExp(`\\.\\.\\.\\(?${match[1]}\\.plugins\\b`, 'u').test(source)) continue;
        inherited = read(resolve(dirname(path), `${match[2]}.ts`));
        if (inherited) break;
      }
    }
    if (!directResolver && !inherited) return null;
    const setup = /\bglobalSetup\s*:\s*\[([^\]]*)\]/u.exec(source);
    if (!setup && /\bglobalSetup\s*:/u.test(source)) return null;
    if (!setup) return inherited ?? { buildsDist: false };
    let buildsDist = false;
    for (const entry of setup[1].split(',').map(value => value.trim()).filter(Boolean)) {
      const literal = /^['"](.+)['"]$/u.exec(entry);
      if (!literal) return null;
      let setupSource;
      try { setupSource = readFileSync(resolve(dirname(path), literal[1]), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!/from\s*['"]\.\/test-setup['"]/u.test(setupSource)) return null;
      if (/\bbuildMode\s*:\s*['"]full['"]/u.test(setupSource)) buildsDist = true;
      else if (!/\bbuildMode\s*:\s*['"]none['"]/u.test(setupSource)) return null;
    }
    return { buildsDist };
  };
  return read(resolve(configPath));
}
