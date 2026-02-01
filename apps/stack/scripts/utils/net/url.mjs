export function normalizeUrlNoTrailingSlash(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';

  let u;
  try {
    u = new URL(s);
  } catch {
    // Best-effort: if it's a plain string with trailing slash, trim it.
    return s.endsWith('/') ? s.replace(/\/+$/, '') : s;
  }

  // Only normalize "base" URLs without search/hash.
  // If search/hash is present, removing slashes can change semantics.
  if (u.search || u.hash) {
    return u.toString();
  }

  // Normalize multiple trailing slashes down to none (root) or one-less (non-root).
  const path = u.pathname || '/';
  if (path === '/' || path === '') {
    return u.origin;
  }
  if (path.endsWith('/')) {
    const nextPath = path.replace(/\/+$/, '');
    return `${u.origin}${nextPath}`;
  }
  return u.toString();
}

