export function resolveHappierHomeDirComparableKey(homeDir: string | null | undefined): string | null {
  let value = String(homeDir ?? '').trim();
  if (!value) {
    return null;
  }

  value = value.replace(/[\\/]+$/, '');
  if (!value) {
    return null;
  }

  const isWindowsishPath =
    /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('//')
    || value.includes('\\');

  if (isWindowsishPath) {
    if (value.startsWith('\\\\')) {
      value = value.replace(/^\\\\+/, '//');
    }
    value = value.replace(/[\\]+/g, '/');
    value = value.replace(/\/{3,}/g, '//');
    value = value.toLowerCase();
    value = value.replace(/\/+$/, '');
  }

  return value || null;
}
