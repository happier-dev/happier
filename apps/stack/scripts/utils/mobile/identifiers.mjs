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
  if (!cleaned) return 'happier-dev';
  return /^[a-z]/.test(cleaned) ? cleaned : `h${cleaned}`;
}

export function stackSlugForMobileIds(stackName) {
  const raw = (stackName ?? '').toString().trim();
  return sanitizeBundleIdSegment(raw || 'stack');
}

function normalizeDevClientProfile(raw) {
  const value = (raw ?? '').toString().trim().toLowerCase();
  if (!value || value === 'internaldev' || value === 'internal' || value === 'development') return 'internaldev';
  if (value === 'publicdev' || value === 'public' || value === 'dev') return 'publicdev';
  throw new Error(`[mobile-dev-client] unsupported profile: ${value}`);
}

const DEV_CLIENT_IDENTITIES = Object.freeze({
  internaldev: Object.freeze({
    profile: 'internaldev',
    appEnv: 'internaldev',
    iosAppName: 'Happier (internal dev)',
    iosBundleId: 'dev.happier.app.dev.internal.devclient',
    androidPackage: 'dev.happier.app.internaldev.devclient',
    scheme: 'happier-internaldev',
    easBuildProfile: 'internaldev-dev-client',
  }),
  publicdev: Object.freeze({
    profile: 'publicdev',
    appEnv: 'publicdev',
    iosAppName: 'Happier (dev)',
    iosBundleId: 'dev.happier.app.publicdev.devclient',
    androidPackage: 'dev.happier.app.publicdev.devclient',
    scheme: 'happier-dev',
    easBuildProfile: 'publicdev-dev-client',
  }),
});

export function defaultDevClientIdentity({ user = null, profile = null } = {}) {
  const normalizedProfile = normalizeDevClientProfile(profile);
  return { ...DEV_CLIENT_IDENTITIES[normalizedProfile] };
}

export function defaultStackReleaseIdentity({ stackName, user = null, appName = null } = {}) {
  const slug = stackSlugForMobileIds(stackName);
  const u = sanitizeBundleIdSegment(user ?? 'user');
  const label = (appName ?? '').toString().trim();
  return {
    iosAppName: label || `Happier (${stackName})`,
    iosBundleId: `dev.happier.stack.stack.${u}.${slug}`,
    scheme: sanitizeUrlScheme(`happier-${slug}`),
  };
}
