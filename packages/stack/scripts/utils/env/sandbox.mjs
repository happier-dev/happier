export function getSandboxDir() {
  const v = (process.env.HAPPY_STACKS_SANDBOX_DIR ?? '').trim();
  return v || '';
}

export function isSandboxed() {
  return Boolean(getSandboxDir());
}

export function sandboxAllowsGlobalSideEffects() {
  const raw = (process.env.HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

