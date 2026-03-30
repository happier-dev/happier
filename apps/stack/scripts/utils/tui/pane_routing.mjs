export function resolveTuiPaneIdForLabel(label) {
  const normalized = String(label ?? '').trim().toLowerCase();
  if (normalized === 'tauri') return 'tauri';
  if (normalized.includes('server')) return 'server';
  if (normalized === 'ui') return 'expo';
  if (normalized === 'mobile') return 'expo';
  if (normalized === 'expo') return 'expo';
  if (normalized.includes('daemon')) return 'daemon';
  if (normalized === 'stack') return 'stacklog';
  if (normalized === 'local') return 'local';
  return 'local';
}
