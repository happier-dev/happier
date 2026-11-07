import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '../presentationHost/scrollActivity.js';

const layerStyle: ViewStyle = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
const subscribeWithoutViewport = () => () => {};

/** The moving highlight observes its own row-sized layer; it never owns or changes scrolling. */
export function CollectionRowVisibility(props: Readonly<{ children: ReactNode; testID?: string }>) {
  const target = useRef<View | null>(null);
  const tracker = useOptionalPluginUiScrollActivityTracker();
  const [visible, setVisible] = useState(false);
  const [span, setSpan] = useState<Readonly<{ top: number; height?: number }> | null>(null);
  const measure = useRef<() => void>(() => {});
  useEffect(() => {
    if (Platform.OS === 'web' || tracker === null) return;
    let active = true;
    let revision = tracker.getLayoutRevision();
    const place = async () => {
      const next = await tracker.measureSpan(target.current);
      if (active) setSpan(previous => previous?.top === next?.top && previous?.height === next?.height ? previous : next);
    };
    measure.current = () => { void place(); };
    measure.current();
    const release = tracker.subscribe(() => {
      const next = tracker.getLayoutRevision();
      if (revision === next) return;
      revision = next;
      measure.current();
    });
    return () => { active = false; measure.current = () => {}; release(); };
  }, [tracker]);
  const readNativeVisibility = useCallback(() => {
    const window = tracker?.getVisibleWindow?.();
    return span !== null && span.height !== undefined && span.height > 0 && window !== undefined && window !== null
      && span.top < window.bottom && span.top + span.height > window.top;
  }, [span, tracker]);
  const nativeVisible = useSyncExternalStore(
    Platform.OS === 'web' ? subscribeWithoutViewport : tracker?.subscribeVisibleWindow ?? subscribeWithoutViewport,
    readNativeVisibility, readNativeVisibility,
  );
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = target.current;
    if (!(node instanceof Element) || typeof IntersectionObserver !== 'function') return;
    // The viewport root includes clipping by every ancestor, including a containing page scroller.
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === node);
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <View ref={target} pointerEvents="none" collapsable={false} style={layerStyle} onLayout={() => measure.current()}
    testID={props.testID === undefined ? undefined : `${props.testID}:viewport`}>
    {(Platform.OS === 'web' ? visible : nativeVisible) ? props.children : null}
  </View>;
}
