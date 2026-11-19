import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  shouldSkipServerSharedDepsBuild,
  shouldUseCliSourceEntrypoint,
} from '../../../../../packages/tests/src/testkit/process/providerSourcePreparation.mjs';

// The `plugins: [...]` list text with nested brackets balanced (`?? []` inside
// an element must not end the list).
function pluginListText(source) {
  const start = /\bplugins\s*:\s*\[/u.exec(source);
  if (!start) return null;
  let depth = 0;
  for (let index = start.index + start[0].length - 1; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    else if (source[index] === ']' && --depth === 0) return source.slice(start.index + start[0].length, index);
  }
  return null;
}

/** Read resolver declarations without evaluating configs or running global setup. */
export function readVitestSourcePreparation(repoRoot, configPath, env = {}) {
  const sourceResolver = resolve(repoRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts');
  const hasSourcePlugin = (path, source, name, symbolVisits = new Set()) => {
    const key = `${path}:${name}`;
    if (symbolVisits.has(key)) return false;
    symbolVisits.add(key);
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]((?:\.\.?\/)[^'"]+)['"]/gu)) {
      for (const binding of match[1].split(',').map(value => value.trim())) {
        const [imported, local = imported] = binding.split(/\s+as\s+/u);
        if (local !== name) continue;
        const target = resolve(dirname(path), match[2].replace(/\.ts$/u, '') + '.ts');
        if (target === sourceResolver) return imported === 'createWorkspacePackageSourcesPlugin';
        try { return hasSourcePlugin(target, readFileSync(target, 'utf8'), imported, symbolVisits); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }
    }
    const declaration = new RegExp(`\\b(?:const|let)\\s+${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*([\\s\\S]*?)(?:\\n\\};|;(?=\\s*(?:export|const|let|$)))`, 'u').exec(source);
    if (!declaration) return false;
    const expression = declaration[1];
    for (const call of expression.matchAll(/\b(\w+)\s*(?:\(|\.resolveId\s*\()/gu)) {
      if (hasSourcePlugin(path, source, call[1], symbolVisits)) return true;
    }
    return false;
  };
  const visited = new Set();
  const read = (path) => {
    if (visited.has(path)) return null;
    visited.add(path);
    let source;
    try { source = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const hasPlugins = /\bplugins\s*:/u.test(source);
    const pluginList = pluginListText(source);
    const directResolver = pluginList !== null && [...pluginList.matchAll(/\b(\w+)\b/gu)]
      .some(match => hasSourcePlugin(path, source, match[1]));
    let inherited;
    if (!directResolver) {
      for (const match of source.matchAll(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+['"]((?:\.\.?\/)[^'"]*vitest(?:\.[\w-]+)*\.config)(?:\.ts)?['"]/gu)) {
        const baseName = new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${match[1]}(?:\\s+as\\s+[^;]+)?;`, 'u').exec(source)?.[1] ?? match[1];
        // Forwarding the complete plugin list preserves the source resolver
        // without inheriting the base config's test/globalSetup options.
        if (new RegExp(`\\bplugins\\s*:\\s*${baseName}\\.plugins\\s*[,}]`, 'u').test(source)
          || pluginList !== null && new RegExp(`\\.\\.\\.\\(?${baseName}\\.plugins\\b`, 'u').test(pluginList)) {
          const base = read(resolve(dirname(path), `${match[2]}.ts`));
          if (base && !base.buildsDist) { inherited = base; break; }
        }
        const spreadsBase = new RegExp(`\\.\\.\\.${baseName}\\s*[,}]`, 'u').test(source);
        const mergesBase = new RegExp(`\\bmergeConfig\\(\\s*${baseName}\\s*,`, 'u').test(source)
          && /import\s*\{[^}]*\bmergeConfig\b[^}]*\}\s*from\s*['"]vitest\/config['"]/u.test(source);
        if (!spreadsBase && !mergesBase) continue;
        if (hasPlugins && !mergesBase && !new RegExp(`\\.\\.\\.\\(?${baseName}\\.plugins\\b`, 'u').test(source)) continue;
        inherited = read(resolve(dirname(path), `${match[2]}.ts`));
        if (inherited) break;
      }
    }
    // The core harness merges a config factory that supplies the source resolver.
    if (!directResolver && !inherited
      && /import\s*\{[^}]*\bmergeConfig\b[^}]*\}\s*from\s*['"]vitest\/config['"]/u.test(source)
      && /import\s*\{\s*createUiProductionHooksVitestConfig\s*\}\s*from\s*['"]\.\/vitest\.uiProductionHooks['"]/u.test(source)
      && /\bmergeConfig\(\s*createUiProductionHooksVitestConfig\(\)\s*,/u.test(source)) {
      inherited = read(resolve(dirname(path), 'vitest.uiProductionHooks.ts'));
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
      // Both core setups consume the same decisions as the runtime launchers.
      // Keep arbitrary setup modules on the conservative preparation path.
      if (dirname(path) === resolve(repoRoot, 'packages/tests')
        && /^src\/testkit\/vitest\/globalSetup\.core(?:Fast|Slow)\.ts$/u.test(literal[1])
        && /\bawait prepareCliForGlobalSetup\(/u.test(setupSource)
        && /\bawait prepareServerSharedDepsForRun\(/u.test(setupSource)) {
        if (!shouldUseCliSourceEntrypoint(env) || !shouldSkipServerSharedDepsBuild(env)) return null;
        continue;
      }
      if (!/from\s*['"]\.\/test-setup['"]/u.test(setupSource)) return null;
      if (/\bbuildMode\s*:\s*['"](?:full|shared-only)['"]/u.test(setupSource)) buildsDist = true;
      else if (!/\bbuildMode\s*:\s*['"]none['"]/u.test(setupSource)) return null;
    }
    return { buildsDist };
  };
  return read(resolve(configPath));
}
