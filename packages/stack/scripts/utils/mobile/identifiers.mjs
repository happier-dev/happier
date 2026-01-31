function sanitizeToken(raw, { allowDots = false } = {}) {
  const s = (raw ?? '').toString().trim().toLowerCase();
  const re = allowDots ? /[^a-z0-9.-]+/g : /[^a-z0-9-]+/g;
  const out = s.replace(re, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return out;
}

export function sanitizeBundleIdSegment(s) {
  const seg = sanitizeToken(s, { allowDots: false });
  if (!seg) return 'app';
  // Bundle id segments should not start with a digit; prefix if needed.
  return /^[a-z]/.test(seg) ? seg : `s${seg}`;
}

export function sanitizeUrlScheme(s) {
  // iOS URL schemes must start with a letter and may contain letters/digits/+.-.
  const raw = (s ?? '').toString().trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9+.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return 'happystacks-dev';
  return /^[a-z]/.test(cleaned) ? cleaned : `h${cleaned}`;
}

export function stackSlugForMobileIds(stackName) {
  const raw = (stackName ?? '').toString().trim();
  return sanitizeBundleIdSegment(raw || 'stack');
}

export function defaultDevClientIdentity({ user = null } = {}) {
  const u = sanitizeBundleIdSegment(user ?? 'user');
  return {
    iosAppName: 'Happy Stacks Dev',
    iosBundleId: `com.happystacks.dev.${u}`,
    scheme: 'happystacks-dev',
  };
}

export function defaultStackReleaseIdentity({ stackName, user = null, appName = null } = {}) {
  const slug = stackSlugForMobileIds(stackName);
  const u = sanitizeBundleIdSegment(user ?? 'user');
  const label = (appName ?? '').toString().trim();
  return {
    iosAppName: label || `Happy (${stackName})`,
    iosBundleId: `com.happystacks.stack.${u}.${slug}`,
    scheme: sanitizeUrlScheme(`happystacks-${slug}`),
  };
}

