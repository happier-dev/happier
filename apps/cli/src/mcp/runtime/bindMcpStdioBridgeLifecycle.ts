type EndReadable = Readonly<{
  once: (event: 'end', listener: () => void) => unknown;
}>;

type CloseAwareTransport = {
  onclose?: () => void;
};

export function bindMcpStdioBridgeLifecycle(params: Readonly<{
  stdin: EndReadable;
  transport: CloseAwareTransport;
  closeServer: () => Promise<unknown>;
  closeUpstream?: () => Promise<unknown>;
  onCloseError?: (error: unknown) => void;
}>): void {
  let closePromise: Promise<void> | null = null;
  const closeOnce = (): Promise<void> => {
    if (closePromise) return closePromise;
    // Defer resource callbacks by one microtask so closePromise is assigned
    // before closing the server can synchronously fire transport.onclose.
    const closeResource = (close: (() => Promise<unknown>) | undefined): Promise<void> =>
      close
        ? Promise.resolve()
            .then(close)
            .then(
              () => undefined,
              (error) => params.onCloseError?.(error),
            )
        : Promise.resolve();
    closePromise = Promise.all([
      closeResource(params.closeServer),
      closeResource(params.closeUpstream),
    ]).then(() => undefined);
    return closePromise;
  };

  const previousOnClose = params.transport.onclose;
  params.transport.onclose = () => {
    previousOnClose?.();
    void closeOnce();
  };
  params.stdin.once('end', () => {
    void closeOnce();
  });
}
