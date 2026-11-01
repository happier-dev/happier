export type ManagedToolBootstrapProgress = Readonly<{
  t: 'progress';
  phase: 'waiting-for-lock' | 'fetching-release' | 'downloading' | 'installing';
  bytesDone?: number;
  bytesTotal?: number;
}>;

export type ManagedToolBootstrapOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (event: ManagedToolBootstrapProgress) => void;
}>;
