function canUseLocalStorage(): boolean {
  return (
    typeof localStorage !== 'undefined' &&
    typeof (localStorage as any)?.getItem === 'function'
  );
}

export function isDebugFlagEnabled(params: Readonly<{
  globalKey: string;
  localStorageKey: string;
}>): boolean {
  const { globalKey, localStorageKey } = params;

  if (typeof globalThis !== 'undefined' && (globalThis as any)[globalKey] === true) {
    return true;
  }

  if (!canUseLocalStorage()) return false;
  return localStorage.getItem(localStorageKey) === '1';
}

