import { runBackgroundServiceProcessWorker } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessWorkerEntry';
import type { BackgroundServiceProcessChannel } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel';
import type { TerminationEvent } from '@/subprocess/supervision/types';
import { createDeferred } from '@/testkit/async/deferred';

export type MemoryProcessBoundary = Readonly<{
  children: { channel: BackgroundServiceProcessChannel; closed: boolean; crash(): void }[];
  readers: Readonly<{ agentId: string; current: boolean; available: boolean }>[];
  spawnChannel(): Promise<BackgroundServiceProcessChannel>;
  runs: number;
  holdClose(): Readonly<{ entered: Promise<void>; release(): void }>;
}>;

/** Only the OS pipe/process is replaced; both framed peers, entry and engine stay real. */
export function createMemoryProcessBoundary(): MemoryProcessBoundary {
  const children: { channel: BackgroundServiceProcessChannel; closed: boolean; crash(): void }[] = [];
  const readers: Readonly<{ agentId: string; current: boolean; available: boolean }>[] = [];
  let runs = 0;
  let beforeClose: (() => Promise<void>) | undefined;
  const spawnChannel = async (): Promise<BackgroundServiceProcessChannel> => {
    const parentListeners: ((data: Buffer) => void)[] = [];
    const childListeners: ((data: Buffer) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let finish!: (event: TerminationEvent) => void;
    const termination = new Promise<TerminationEvent>(done => { finish = done; });
    const deliver = (listeners: readonly ((data: Buffer) => void)[], frame: Buffer) => {
      for (const listener of listeners) { listener(frame.subarray(0, 3)); listener(frame.subarray(3)); }
    };
    const worker = runBackgroundServiceProcessWorker({
      onData: listener => { childListeners.push(listener); },
      onClose: listener => { closeListeners.push(listener); },
      write: frame => deliver(parentListeners, frame),
    }, { loadHostEntry: async () => ({ run: async (context, payload) => {
      runs++;
      for (const [agentId, runtime] of context.agentRuntimesByAgentId ?? []) readers.push({ agentId,
        current: runtime.isCurrent() && !runtime.retirementSignal.aborted, available: !!runtime.externalSessions });
      const { runMemoryIndexerService } = await import('./memoryIndexerServiceEntry');
      await runMemoryIndexerService(context, payload);
    } }) });
    const close = async () => {
      for (const listener of closeListeners) listener();
      await worker;
      await beforeClose?.();
      child.closed = true;
      finish({ type: 'exited', code: 0 });
    };
    const channel: BackgroundServiceProcessChannel = {
      pid: 43123 + children.length,
      send: frame => deliver(childListeners, frame),
      onData: listener => { parentListeners.push(listener); },
      waitForTermination: () => termination,
      close, terminate: close,
    };
    const child = { channel, closed: false, crash: () => {
      finish({ type: 'exited', code: 23 });
      for (const listener of closeListeners) listener();
    } };
    children.push(child);
    return channel;
  };
  return { children, readers, spawnChannel, get runs() { return runs; }, holdClose() {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeClose = async () => { entered.resolve(); await release.promise; };
    return { entered: entered.promise, release: release.resolve };
  } };
}
