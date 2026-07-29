import { isAbsolute, relative, resolve, win32 } from 'node:path';

export type ResolvePortablePluginRelativePathResult = Readonly<
  | { ok: true; path: string }
  | { ok: false; message: string }
>;

export function resolvePortablePluginRelativePath(input: Readonly<{
  rootPath: string;
  value: string;
  label: string;
}>): ResolvePortablePluginRelativePathResult {
  const portableValue = input.value.replaceAll('\\', '/');
  if (
    portableValue.length === 0
    || portableValue.includes('\u0000')
    || isAbsolute(portableValue)
    || win32.parse(input.value).root !== ''
  ) {
    return {
      ok: false,
      message: `${input.label} '${input.value}' must be relative to the plugin root`,
    };
  }

  const resolvedPath = resolve(input.rootPath, portableValue);
  const relativePath = relative(input.rootPath, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || isAbsolute(relativePath)) {
    return {
      ok: false,
      message: `${input.label} '${input.value}' escapes the plugin root`,
    };
  }

  return { ok: true, path: resolvedPath };
}
