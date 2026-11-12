import { Platform } from 'react-native';
import { Svg, type SvgProps } from 'react-native-svg';

/** Decorative drawing ink; the caller presents its meaning through accessible text or controls. */
export function HappierDecorativeSvg(props: Omit<SvgProps,
  'accessible' | 'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'>) {
  // react-native-svg forwards native accessibility props verbatim to the web DOM.
  return <Svg {...props} aria-hidden {...(Platform.OS === 'web' ? {} : {
    accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const,
  })} />;
}
