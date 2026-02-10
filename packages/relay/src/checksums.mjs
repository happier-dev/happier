export function lookupSha256({ checksumsText, filename }) {
  const target = String(filename ?? '').trim();
  if (!target) throw new Error('[checksums] filename is required');

  const text = String(checksumsText ?? '');
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^([0-9a-fA-F]{8,})\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const file = m[2].trim();
    if (file === target) return hash;
  }
  throw new Error(`[checksums] sha256 not found for ${target}`);
}
