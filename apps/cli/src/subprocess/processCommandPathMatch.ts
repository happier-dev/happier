function isCommandPathBoundary(value: string | undefined): boolean {
  return value === undefined || /[\s"'=]/u.test(value);
}

export function normalizeProcessCommandPathValue(value: string): string {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  const containsWindowsPath =
    /(?:^|[\s"'=])(?:[a-z]:\/|\/\/)/iu.test(normalized);
  return containsWindowsPath ? normalized.toLowerCase() : normalized;
}

/**
 * Matches a path fragment in a process command without confusing sibling
 * prefixes such as `/opt/happier` and `/opt/happier-old`.
 */
export function processCommandContainsPathFragment(command: string, pathFragment: string): boolean {
  const normalizedCommand = normalizeProcessCommandPathValue(command);
  const normalizedPathFragment = normalizeProcessCommandPathValue(pathFragment);
  if (!normalizedCommand || !normalizedPathFragment) {
    return false;
  }

  let offset = 0;
  while (offset <= normalizedCommand.length - normalizedPathFragment.length) {
    const index = normalizedCommand.indexOf(normalizedPathFragment, offset);
    if (index < 0) {
      return false;
    }
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPathFragment.length];
    if (isCommandPathBoundary(before) && (after === '/' || isCommandPathBoundary(after))) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}
