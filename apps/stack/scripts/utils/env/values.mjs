export function getEnvValue(obj, key) {
  const v = (obj?.[key] ?? '').toString().trim();
  return v || '';
}

export function getEnvValueAny(obj, keys) {
  for (const k of keys) {
    const v = getEnvValue(obj, k);
    if (v) return v;
  }
  return '';
}

