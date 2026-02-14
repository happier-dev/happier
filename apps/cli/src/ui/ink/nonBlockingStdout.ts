export function createNonBlockingStdout<TStdout extends NodeJS.WriteStream>(stdout: TStdout): TStdout {
  let droppingUntilDrain = false;
  let drainListenerInstalled = false;

  const proxy = new Proxy(stdout as any, {
    get(target, prop, receiver) {
      if (prop !== 'write') {
        return Reflect.get(target, prop, receiver);
      }

      return function write(
        chunk: unknown,
        encodingOrCallback?: unknown,
        callbackMaybe?: unknown,
      ): boolean {
        let encoding: BufferEncoding | undefined = undefined;
        let cb: (() => void) | undefined = undefined;

        if (typeof encodingOrCallback === 'function') {
          cb = encodingOrCallback as () => void;
        } else {
          encoding = encodingOrCallback as BufferEncoding | undefined;
          if (typeof callbackMaybe === 'function') {
            cb = callbackMaybe as () => void;
          }
        }

        const needDrain = Boolean(target.writableNeedDrain);
        if (needDrain || droppingUntilDrain) {
          cb?.();
          return true; // Keep Ink from backpressuring its own render loop.
        }

        const ok = encoding
          ? (target.write as any)(chunk, encoding, cb)
          : (target.write as any)(chunk, cb);

        if (!ok && !drainListenerInstalled) {
          droppingUntilDrain = true;
          drainListenerInstalled = true;
          target.once('drain', () => {
            droppingUntilDrain = false;
            drainListenerInstalled = false;
          });
        }

        return ok;
      };
    },
  });

  return proxy as TStdout;
}
