/** Redirect only the native owner's fixed sudoers file and same-parent staging.
 * Real filesystem operations and the native backend remain beneath this boundary. */
export function redirectSudoersFileSystem(
  actual: typeof import('node:fs/promises'),
  readDirectory: () => string,
) {
  const path = <T,>(value: T): T => {
    if (typeof value !== 'string' || value !== '/etc/sudoers.d' && !value.startsWith('/etc/sudoers.d/')) return value;
    const directory = readDirectory();
    if (!directory) throw Object.assign(new Error('Sudoers filesystem fixture is not active'), { code: 'ENOENT' });
    const suffix = value.slice('/etc/sudoers.d'.length);
    if (suffix && suffix !== '/90-happier-daemon' && !suffix.startsWith('/.happier-setup-')) {
      throw new Error('Unexpected path outside the native sudoers fixture');
    }
    // The OS adapter changes only string paths; preserve other native overloads.
    return (directory + suffix) as T;
  };
  return { ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => actual.lstat(path(args[0]), args[1]),
    readFile: (...args: Parameters<typeof actual.readFile>) => actual.readFile(path(args[0]), args[1]),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => actual.writeFile(path(args[0]), args[1], args[2]),
    chmod: (...args: Parameters<typeof actual.chmod>) => actual.chmod(path(args[0]), args[1]),
    chown: (...args: Parameters<typeof actual.chown>) => actual.chown(path(args[0]), args[1], args[2]),
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => actual.mkdtemp(path(args[0]), args[1]),
    rename: (...args: Parameters<typeof actual.rename>) => actual.rename(path(args[0]), path(args[1])),
    unlink: (...args: Parameters<typeof actual.unlink>) => actual.unlink(path(args[0])),
    rm: (...args: Parameters<typeof actual.rm>) => actual.rm(path(args[0]), args[1]),
  };
}
