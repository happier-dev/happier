export function parseNameStatusZ(buf) {
  const raw = String(buf ?? '');
  if (!raw) return [];
  const parts = raw.split('\0').filter((x) => x.length);
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    const code = status[0] ?? '';
    if (!code) break;
    if (code === 'R' || code === 'C') {
      const from = parts[i++] ?? '';
      const to = parts[i++] ?? '';
      entries.push({ code, status, from, to });
      continue;
    }
    const path = parts[i++] ?? '';
    entries.push({ code, status, path });
  }
  return entries;
}
