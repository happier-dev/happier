export type StoreSet<S> = {
  (partial: S | Partial<S> | ((state: S) => S | Partial<S>), replace?: false): void;
  (state: S | ((state: S) => S), replace: true): void;
};

export type StoreGet<S> = () => S;

/** Declare inputs of an external-owner query so the store's read tracking can subscribe to them. */
export function readStoreQuery<S, T>(get: StoreGet<S>, inputs: readonly (keyof S)[], read: () => T): T {
  const state = get();
  for (const key of inputs) void state[key];
  return read();
}
