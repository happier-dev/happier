const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isScopeIdSafe(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return SERVER_ID_SAFE_RE.test(value);
}

function normalizeScopePart(raw, fallback) {
  const base = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '');
  return base || fallback;
}

function hashFNV1a32(value) {
  const text = String(value ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function clipPart(value, maxLength) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.length <= maxLength) return v;
  return v.slice(0, maxLength).replace(/[-._]+$/, '');
}

export function buildStackStableScopeId({ stackName = 'main', cliIdentity = 'default' } = {}) {
  const stack = normalizeScopePart(stackName, 'main');
  const identity = normalizeScopePart(cliIdentity, 'default');

  const base = `stack_${stack}__id_${identity}`;
  if (isScopeIdSafe(base)) return base;

  const hash = hashFNV1a32(`${stack}::${identity}`);
  const stackShort = clipPart(stack, 20) || 'main';
  const identityShort = clipPart(identity, 20) || 'default';
  const compact = `stack_${stackShort}__id_${identityShort}__${hash}`;
  if (isScopeIdSafe(compact)) return compact;

  const fallback = `stack_${hash}`;
  return isScopeIdSafe(fallback) ? fallback : 'stack-default';
}

export function isStableScopeDisabled(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_DISABLE_STABLE_SCOPE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function resolveStackActiveServerId({ env = process.env, stackName = null, cliIdentity = null } = {}) {
  if (isStableScopeDisabled(env)) return '';
  const explicit = String(env?.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  const inStackContext =
    Boolean((stackName ?? '').toString().trim()) ||
    Boolean((cliIdentity ?? '').toString().trim()) ||
    Boolean((env?.HAPPIER_STACK_STACK ?? '').toString().trim()) ||
    Boolean((env?.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim());
  if (!inStackContext && isScopeIdSafe(explicit)) return explicit;

  const name =
    (stackName ?? '').toString().trim() ||
    (env?.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    'main';
  const identity =
    (cliIdentity ?? '').toString().trim() ||
    (env?.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() ||
    'default';
  return buildStackStableScopeId({ stackName: name, cliIdentity: identity });
}

export function applyStackActiveServerScopeEnv({ env = process.env, stackName = null, cliIdentity = null } = {}) {
  const base = { ...(env ?? {}) };
  const activeServerId = resolveStackActiveServerId({ env: base, stackName, cliIdentity });
  if (!activeServerId) {
    delete base.HAPPIER_ACTIVE_SERVER_ID;
    return base;
  }
  base.HAPPIER_ACTIVE_SERVER_ID = activeServerId;
  return base;
}
