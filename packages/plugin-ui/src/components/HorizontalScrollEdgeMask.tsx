import { Platform } from 'react-native';
import { HappierHorizontalScrollEdgeMask, type HappierHorizontalScrollEdgeMaskProps } from '../presentation/layout/HorizontalScrollEdgeMask.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type HorizontalScrollEdgeMaskProps = Omit<HappierHorizontalScrollEdgeMaskProps, 'nativeHost'>;

/** Fade clipped rail content with the shared mask geometry on web and the host's native alpha mask. */
export function HorizontalScrollEdgeMask(props: HorizontalScrollEdgeMaskProps) {
  const host = useOptionalPluginUiPresentationHost();
  if (Platform.OS !== 'web' && host?.renderHorizontalScrollEdgeMask) {
    return <>{host.renderHorizontalScrollEdgeMask(props)}</>;
  }
  return <HappierHorizontalScrollEdgeMask {...props} />;
}
