import { stopCaffeinate } from '@/integrations/caffeinate';

export async function cleanupBackendRunResources(opts: {
  keepAliveInterval: ReturnType<typeof setInterval>;
  reconnectionHandle?: { cancel: () => void } | null;
  stopMcpServer: () => void;
  resetRuntime: () => Promise<void>;
  unmountUi: () => void;
}): Promise<void> {
  clearInterval(opts.keepAliveInterval);
  opts.reconnectionHandle?.cancel();
  stopCaffeinate();
  opts.stopMcpServer();
  await opts.resetRuntime();
  opts.unmountUi();
}
