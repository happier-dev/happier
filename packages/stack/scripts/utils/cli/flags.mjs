export function boolFromFlags({ flags, onFlag, offFlag, defaultValue }) {
  if (flags.has(offFlag)) return false;
  if (flags.has(onFlag)) return true;
  return defaultValue;
}

export function boolFromFlagsOrKv({ flags, kv, onFlag, offFlag, key, defaultValue }) {
  if (flags.has(offFlag)) return false;
  if (flags.has(onFlag)) return true;
  if (key && kv.has(key)) {
    const raw = String(kv.get(key) ?? '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  }
  return defaultValue;
}

