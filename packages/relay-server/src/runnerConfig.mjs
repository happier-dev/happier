import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

function parseArgs(argv) {
  const kv = new Map();
  const flags = new Set();
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!String(a ?? '').startsWith('--')) {
      positionals.push(String(a));
      continue;
    }
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      kv.set(a, String(next));
      i += 1;
      continue;
    }
    flags.add(String(a));
    kv.set(a, 'true');
  }
  return { kv, flags, positionals };
}

function normalizeChannel(raw) {
  const requested = String(raw ?? '').trim() || 'stable';
  const channel = normalizePublicReleaseRingId(requested);
  if (!channel) {
    throw new Error(`Invalid --channel '${requested}'. Expected stable|preview|dev.`);
  }
  return channel;
}

function parseBooleanFlag(raw, fallback) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'y' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'n' || value === 'off') return false;
  return fallback;
}

export function parseRunnerInvocation(argv = []) {
  const { kv, flags, positionals } = parseArgs(Array.isArray(argv) ? argv : []);
  const channel = normalizeChannel(kv.get('--channel'));
  const suffix = getReleaseRingCatalogEntry(channel).rollingReleaseSuffix;
  if (!suffix) {
    throw new Error(`Missing rolling release suffix for channel '${channel}'.`);
  }
  const serverTag = String(kv.get('--tag') ?? '').trim() || `server-${suffix}`;
  const uiWebTag = String(kv.get('--ui-tag') ?? '').trim() || `ui-web-${suffix}`;

  const withUiWeb =
    !(flags.has('--without-ui') || parseBooleanFlag(kv.get('--with-ui'), true) === false);

  return {
    channel,
    serverTag,
    uiWebTag,
    withUiWeb,
    positionals,
  };
}
