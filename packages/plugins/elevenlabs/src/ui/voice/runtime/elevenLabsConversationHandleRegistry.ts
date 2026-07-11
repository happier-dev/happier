import type { ElevenLabsConversationHandle } from './createElevenLabsConversationHandle.js';

export type ElevenLabsConversationHandleMode = 'voice' | 'text';

type RegistryEntry = Readonly<{
  registrationId: number;
  handle: ElevenLabsConversationHandle;
}>;

type Waiter = Readonly<{
  resolve: (handle: ElevenLabsConversationHandle) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
}>;

function abortError(): Error {
  return Object.assign(new Error('elevenlabs_handle_wait_aborted'), { name: 'AbortError' });
}

export function createElevenLabsConversationHandleRegistry() {
  const currentByMode = new Map<ElevenLabsConversationHandleMode, RegistryEntry>();
  const waitersByMode = new Map<ElevenLabsConversationHandleMode, Set<Waiter>>();
  let nextRegistrationId = 0;

  const settleWaiters = (mode: ElevenLabsConversationHandleMode, handle: ElevenLabsConversationHandle): void => {
    const waiters = waitersByMode.get(mode);
    if (!waiters) return;
    waitersByMode.delete(mode);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(handle);
    }
  };

  return Object.freeze({
    register(mode: ElevenLabsConversationHandleMode, handle: ElevenLabsConversationHandle): () => void {
      const registrationId = ++nextRegistrationId;
      currentByMode.set(mode, { registrationId, handle });
      settleWaiters(mode, handle);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (currentByMode.get(mode)?.registrationId === registrationId) {
          currentByMode.delete(mode);
        }
      };
    },
    current(mode: ElevenLabsConversationHandleMode): ElevenLabsConversationHandle | null {
      return currentByMode.get(mode)?.handle ?? null;
    },
    async waitForCurrent(
      mode: ElevenLabsConversationHandleMode,
      signal: AbortSignal,
      timeoutMs?: number,
    ): Promise<ElevenLabsConversationHandle> {
      if (signal.aborted) throw abortError();
      const current = currentByMode.get(mode)?.handle;
      if (current) return current;

      return await new Promise<ElevenLabsConversationHandle>((resolve, reject) => {
        let waiter!: Waiter;
        const onAbort = (): void => {
          const waiters = waitersByMode.get(mode);
          waiters?.delete(waiter);
          if (waiters?.size === 0) waitersByMode.delete(mode);
          if (waiter.timeout) clearTimeout(waiter.timeout);
          reject(abortError());
        };
        const timeout = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
          ? setTimeout(() => {
              const waiters = waitersByMode.get(mode);
              waiters?.delete(waiter);
              if (waiters?.size === 0) waitersByMode.delete(mode);
              signal.removeEventListener('abort', onAbort);
              reject(new Error('elevenlabs_handle_wait_timeout'));
            }, Math.max(1, Math.floor(Number(timeoutMs))))
          : null;
        waiter = { resolve, reject, signal, onAbort, timeout };
        const waiters = waitersByMode.get(mode) ?? new Set<Waiter>();
        waiters.add(waiter);
        waitersByMode.set(mode, waiters);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
}

export type ElevenLabsConversationHandleRegistry = ReturnType<typeof createElevenLabsConversationHandleRegistry>;

export const elevenLabsConversationHandleRegistry = createElevenLabsConversationHandleRegistry();
