export type VoiceRemoteCatalogState<Row> =
  | Readonly<{ phase: 'idle' | 'loading' | 'error' }>
  | Readonly<{ phase: 'ready'; rows: readonly Row[] }>;
