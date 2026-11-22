import * as React from 'react';

type FooterStore = Readonly<{
  set: (footer: React.ReactNode | null) => void;
  get: () => React.ReactNode | null;
  subscribe: (listener: () => void) => () => void;
}>;

function createFooterStore(): FooterStore {
  let footer: React.ReactNode | null = null;
  const listeners = new Set<() => void>();
  return {
    set: (next) => {
      footer = next;
      listeners.forEach((listener) => listener());
    },
    get: () => footer,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A host card that offers its footer to the plugin form it hosts (`ModalCardFooterActions`). */
export const PluginModalCardFooterSlotContext = React.createContext<
  FooterStore['set'] | null
>(null);

/**
 * One footer store per host card: the plugin form publishes its footer actions, and the card's footer renders the
 * latest (or `fallback` until the form offers one), so the form's primary stays pinned beside the card's edge.
 */
export function usePluginModalCardFooterSlot() {
  const [store] = React.useState(createFooterStore);
  return store;
}

export function PluginModalCardFooterSlot(
  props: Readonly<{ store: FooterStore; fallback: React.ReactNode }>,
) {
  const footer = React.useSyncExternalStore(
    props.store.subscribe,
    props.store.get,
    props.store.get,
  );
  return <>{footer ?? props.fallback}</>;
}
