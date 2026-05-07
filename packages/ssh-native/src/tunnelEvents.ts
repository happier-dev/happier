export type NativeSshTunnelEvent = Readonly<{
  nativeTunnelId: string;
  phase: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  message?: string;
}>;
