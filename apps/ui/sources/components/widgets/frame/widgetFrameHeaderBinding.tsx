import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PaneHeaderLineView } from '@/components/appShell/panes/PaneHeader';
import type { PluginPaneHeaderSlotInput } from '@/components/appShell/panes/paneHeaderSlot';

import {
  WidgetFrameBodyMetaContext,
  useWidgetFrameBodyCaption,
  useWidgetFrameBodyMeta,
  useWidgetFrameBodyOpen,
} from './widgetFrameBodyCaption';

type HeaderInputStore = Readonly<{
  set(input: PluginPaneHeaderSlotInput): void;
  get(): PluginPaneHeaderSlotInput;
  subscribe(listener: () => void): () => void;
}>;

const NO_INPUT: PluginPaneHeaderSlotInput = Object.freeze({
  line: null,
  actions: null,
});

function createHeaderInputStore(): HeaderInputStore {
  let current = NO_INPUT;
  const listeners = new Set<() => void>();
  return {
    set(input) {
      if (input.line === current.line && input.actions === current.actions)
        return;
      current = input;
      listeners.forEach((listener) => listener());
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The frame's meta leaf: the only thing that re-renders when the plugin's line or actions change. */
function PluginWidgetFrameHeaderMeta(
  props: Readonly<{ store: HeaderInputStore }>,
) {
  const { line, actions } = React.useSyncExternalStore(
    props.store.subscribe,
    props.store.get,
    props.store.get,
  );
  const facts = React.useMemo(
    () => (line === null || line.length === 0 ? null : { segments: line }),
    [line],
  );
  if (facts === null && actions === null) return null;
  return (
    <View style={styles.meta}>
      {facts ? (
        <PaneHeaderLineView line={facts} testID="widget-frame.plugin-header" />
      ) : null}
      {actions}
    </View>
  );
}

function PluginWidgetFrameHeaderPublisher(
  props: Readonly<{ input: PluginPaneHeaderSlotInput }>,
) {
  const [store] = React.useState(createHeaderInputStore);
  // One stable node is lent for the mount's lifetime: the frame's placement holds it in its own state, so
  // lending a fresh node per plugin render would re-render the plugin body from above, over and over.
  const [meta] = React.useState(() => (
    <PluginWidgetFrameHeaderMeta store={store} />
  ));
  React.useLayoutEffect(() => {
    store.set(props.input);
  });
  useWidgetFrameBodyMeta(meta);
  // The body's own name for where it comes from ("Tasks"), in the frame's source slot, as a built-in body lends it.
  useWidgetFrameBodyCaption(props.input.caption ?? null);
  // …and the way to that page, as the frame's one footer link ("Open Tasks").
  const destination = props.input.caption ?? null;
  const onOpen = props.input.open ?? null;
  const open = React.useMemo(
    () => (destination === null || onOpen === null ? null : { destination, onPress: onOpen }),
    [destination, onOpen],
  );
  useWidgetFrameBodyOpen(open);
  return null;
}

/**
 * The binding a mounted plugin body receives inside a widget frame whose placement lends its header
 * (Home, a Board): what the plugin's `PaneHeaderContent` says (its one live fact, its "+") lands in the
 * frame's header meta, as it lands in a tab's pane header. `null` outside such a frame.
 */
export function useWidgetFrameHeaderBinding(): Readonly<{
  renderPaneHeader(input: PluginPaneHeaderSlotInput): React.ReactNode;
}> | null {
  const lend = React.useContext(WidgetFrameBodyMetaContext);
  return React.useMemo(
    () =>
      lend === null
        ? null
        : {
            renderPaneHeader: (input: PluginPaneHeaderSlotInput) => (
              <PluginWidgetFrameHeaderPublisher input={input} />
            ),
          },
    [lend],
  );
}

const styles = StyleSheet.create((theme) => ({
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
}));
