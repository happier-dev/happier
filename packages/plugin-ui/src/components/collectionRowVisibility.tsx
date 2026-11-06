import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

const layerStyle: ViewStyle = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };

/** The moving highlight observes its own row-sized layer; it never owns or changes scrolling. */
export function CollectionRowVisibility(props: Readonly<{ children: ReactNode; testID?: string }>) {
  const target = useRef<View | null>(null);
  const [visible, setVisible] = useState(Platform.OS !== 'web');
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
  return <View ref={target} pointerEvents="none" collapsable={false} style={layerStyle}
    testID={props.testID === undefined ? undefined : `${props.testID}:viewport`}>
    {visible ? props.children : null}
  </View>;
}
