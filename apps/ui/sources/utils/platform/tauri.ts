export function isTauriDesktop(): boolean {
  const internals =
    (globalThis as any).__TAURI_INTERNALS__ ??
    (typeof window !== 'undefined' ? (window as any).__TAURI_INTERNALS__ : undefined);
  return internals !== undefined;
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const internals =
    (globalThis as any).__TAURI_INTERNALS__ ??
    (typeof window !== 'undefined' ? (window as any).__TAURI_INTERNALS__ : undefined);
  const invokeFromInternals = internals?.invoke;
  if (typeof invokeFromInternals === 'function') {
    return invokeFromInternals(command, args) as T;
  }

  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(command, args);
}

