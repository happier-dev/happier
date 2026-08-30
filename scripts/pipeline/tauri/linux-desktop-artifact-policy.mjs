// @ts-check

/** @type {const} */
export const LINUX_HOST_GRAPHICS_LIBRARY_PATTERNS = [
  'libwayland-client.so',
  'libwayland-cursor.so',
  'libwayland-egl.so',
  'libwayland-server.so',
];

/**
 * @param {string} filePath
 */
export function isLinuxHostGraphicsLibrary(filePath) {
  const name = String(filePath).split('/').pop() ?? '';
  return LINUX_HOST_GRAPHICS_LIBRARY_PATTERNS.some((pattern) => name === pattern || name.startsWith(`${pattern}.`));
}

/**
 * @param {string} fileName
 */
export function isLinuxDesktopPackage(fileName) {
  return /\.(deb|rpm)$/i.test(String(fileName));
}

/**
 * Validate package metadata through the native package inspector.
 * @param {string} packagePath
 * @param {(command: string, args: string[]) => string} inspect
 */
export function validateLinuxPackageMetadata(packagePath, inspect) {
  const fileName = String(packagePath);
  let output;
  if (fileName.toLowerCase().endsWith('.deb')) {
    output = inspect('dpkg-deb', ['--show', '--showformat', '${Package}\\n${Version}\\n${Architecture}\\n', fileName]);
    if (!/^.+\n.+\n(?:amd64|x86_64)\n$/m.test(output)) throw new Error(`invalid DEB metadata: ${fileName}`);
    return;
  }
  if (fileName.toLowerCase().endsWith('.rpm')) {
    output = inspect('rpm', ['-qp', '--queryformat', '%{NAME}\\n%{VERSION}-%{RELEASE}\\n%{ARCH}\\n', fileName]);
    if (!/^.+\n.+\n(?:x86_64|amd64)\n$/m.test(output)) throw new Error(`invalid RPM metadata: ${fileName}`);
    return;
  }
  throw new Error(`unsupported Linux package: ${fileName}`);
}
