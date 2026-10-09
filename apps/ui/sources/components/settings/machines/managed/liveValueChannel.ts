import * as React from 'react';

/** A value a page publishes to a sheet it opened, so the open sheet follows the live page. */
export type LiveValueChannel<T> = Readonly<{
  get: () => T;
  subscribe: (listener: () => void) => () => void;
}>;

/**
 * A modal sheet renders outside the page's tree, so it cannot receive new props. The page publishes
 * each new value here and the sheet subscribes (`useLiveValue`), instead of showing a stale snapshot.
 */
export function useLiveValueChannel<T>(value: T): LiveValueChannel<T> {
  const [state] = React.useState(() => ({
    current: value,
    listeners: new Set<() => void>(),
  }));
  React.useEffect(() => {
    if (state.current === value) return;
    state.current = value;
    for (const listener of state.listeners) listener();
  }, [value, state]);
  return React.useMemo(
    () => ({
      get: () => state.current,
      subscribe: (listener: () => void) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    }),
    [state],
  );
}

export function useLiveValue<T>(channel: LiveValueChannel<T>): T {
  return React.useSyncExternalStore(
    channel.subscribe,
    channel.get,
    channel.get,
  );
}
