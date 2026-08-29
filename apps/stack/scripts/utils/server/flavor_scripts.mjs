import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readScripts(serverDir) {
  try {
    const pkgPath = join(serverDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return {};
  }
}

function hasScript(scripts, name) {
  return typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0;
}

export function resolveServerDevScript({ serverComponentName, serverDir, prismaPush }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happier-server') {
    return 'start';
  }

  if (serverComponentName === 'happier-server-light') {
    // Prefer the dedicated dev script that ensures migrations are applied before starting.
    if (hasScript(scripts, 'dev:light')) {
      return 'dev:light';
    }
    // Fallback: no dev script, run the light start script.
    if (hasScript(scripts, 'start:light')) {
      return 'start:light';
    }

    // Legacy behavior: prefer `dev` for older server-light checkouts.
    if (prismaPush) {
      return hasScript(scripts, 'dev') ? 'dev' : 'start';
    }
    return hasScript(scripts, 'start') ? 'start' : 'dev';
  }

  // Unknown: be conservative.
  return 'start';
}

export function resolveServerStartScript({ serverComponentName, serverDir }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happier-server-light') {
    if (hasScript(scripts, 'start:light')) {
      return 'start:light';
    }
  }

  return 'start';
}
