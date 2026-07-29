type RealtimeStorageProjection = Readonly<{
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: 'idle' | 'speaking';
}>;

type RealtimeStoragePort = Readonly<{
  setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected') => void;
  setRealtimeMode: (mode: 'idle' | 'speaking', immediate?: boolean) => void;
  clearRealtimeModeDebounce: () => void;
}>;

export function createRealtimeMachineStorageMirror<Snapshot extends Readonly<{ adapterId: string | null }>>(input: Readonly<{
  adapterId: string;
  getSnapshot: () => Snapshot;
  subscribe: (listener: () => void) => () => void;
  projectSnapshot: (snapshot: Snapshot) => RealtimeStorageProjection;
  getStoragePort: () => RealtimeStoragePort;
}>): () => void {
  let wasOwner = false;
  let lastMirrorKey: string | null = null;

  const mirror = (): void => {
    const runtime = input.getSnapshot();
    const isOwner = runtime.adapterId === input.adapterId;
    if (!isOwner && !wasOwner) return;
    wasOwner = isOwner;
    const projection = input.projectSnapshot(runtime);
    const shouldResetMode = projection.status === 'disconnected' || projection.status === 'error';
    const status = projection.status === 'error' ? 'disconnected' : projection.status;
    const mode = shouldResetMode ? 'idle' : projection.mode;
    const mirrorKey = `${status}:${mode}:${shouldResetMode ? '1' : '0'}`;
    if (lastMirrorKey === mirrorKey) return;
    lastMirrorKey = mirrorKey;
    const port = input.getStoragePort();
    port.setRealtimeStatus(status);
    port.setRealtimeMode(mode, shouldResetMode);
    if (shouldResetMode) port.clearRealtimeModeDebounce();
  };

  return input.subscribe(mirror);
}
