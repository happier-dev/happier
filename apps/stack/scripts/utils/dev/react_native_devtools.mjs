function normalizePath(raw) {
  const p = String(raw ?? '').trim();
  if (!p) return null;
  if (p.startsWith('/')) return p;
  return `/${p}`;
}

export function resolveReactNativeDevtoolsUrl({
  metroUrl,
  env = process.env,
} = {}) {
  const base = String(metroUrl ?? '').trim();
  if (!base) return null;
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }

  const path = normalizePath(env.HAPPIER_STACK_RN_DEVTOOLS_PATH) ?? '/debugger-ui';
  u.pathname = path;
  u.search = '';
  u.hash = '';
  return u.toString();
}

