export function resolveHappierHomeDirComparableKey(
  homeDir: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let value = String(homeDir ?? '').trim();
  if (!value) {
    return null;
  }

  value = value.replace(/[\\/]+$/, '');
  if (!value) {
    return null;
  }

  const posixWindowsDriveMatch = platform === 'win32'
    ? /^\/([a-zA-Z])\/(.*)$/u.exec(value)
    : null;
  if (posixWindowsDriveMatch) {
    const driveLetter = posixWindowsDriveMatch[1]?.toLowerCase() ?? '';
    const remainder = String(posixWindowsDriveMatch[2] ?? '').replace(/[\\]+/g, '/');
    value = `${driveLetter}:/${remainder}`;
  }

  if (platform === 'win32') {
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
