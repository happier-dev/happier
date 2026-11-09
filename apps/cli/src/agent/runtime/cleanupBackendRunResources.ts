export async function cleanupBackendRunResources(opts: {
  stopKeepAlive: () => void;
  reconnectionHandle?: { cancel: () => void } | null;
  stopMcpServer: () => void | Promise<void>;
  resetRuntime: () => Promise<void>;
  unmountUi: () => void | Promise<void>;
}): Promise<void> {
  opts.stopKeepAlive();
  opts.reconnectionHandle?.cancel();
  await opts.stopMcpServer();
  await opts.resetRuntime();
  await opts.unmountUi();
}
