function readTauriInvoke(): unknown {
  const internals =
    (globalThis as any).__TAURI_INTERNALS__ ??
    (typeof window !== 'undefined' ? (window as any).__TAURI_INTERNALS__ : undefined);
  if (typeof internals?.invoke === 'function') {
    return internals.invoke;
  }

  const tauriApi =
    (globalThis as any).__TAURI__ ??
    (typeof window !== 'undefined' ? (window as any).__TAURI__ : undefined);
  return tauriApi?.core?.invoke;
}

export function isTauriDesktop(): boolean {
  if (typeof readTauriInvoke() === 'function') {
    return true;
  }

  const tauriHostFlag =
    (globalThis as { isTauri?: unknown }).isTauri ??
    (typeof window !== 'undefined' ? (window as { isTauri?: unknown }).isTauri : undefined);
  if (tauriHostFlag === true) {
    return true;
  }

  // In some desktop boot phases the global invoke bridge is not yet ready, but the WebView is
  // already identifiable as a Tauri host. This keeps desktop-only UI (settings/overlay) stable
  // during early navigation and native-e2e capture.
  const userAgent =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '';
  return userAgent.toLowerCase().includes('tauri');
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = readTauriInvoke();
  if (typeof invoke === 'function') {
    return invoke(command, args) as T;
  }

  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(command, args);
}

export async function listenTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const mod = await import('@tauri-apps/api/event');
  return mod.listen<T>(event, (tauriEvent) => {
    handler(tauriEvent.payload);
  });
}
