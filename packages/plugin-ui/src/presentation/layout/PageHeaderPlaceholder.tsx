import { View } from 'react-native';
import { HappierSkeletonBlock } from '../feedback/Skeleton.js';
import { HappierPageHeader, type HappierPageHeaderProps } from './PageHeader.js';
import { happierPageTextMetrics } from './pageText.js';

export type HappierPageHeaderPlaceholderProps = Pick<HappierPageHeaderProps,
  'testID' | 'showTitle' | 'largeTitle' | 'columnMaxWidthPx' | 'renderText' | 'leading' | 'meta' | 'renderBack' | 'initialFrameWidthPx'> & Readonly<{
  color: string;
  reducedMotion?: boolean;
}>;

/**
 * The page header's own geometry, reserving its title line before the destination is known. An entity page that
 * already knows its mark and meta facts (a Team's artwork and Home) passes them, so they stand where they land.
 */
export function HappierPageHeaderPlaceholder({ color, reducedMotion, ...props }: HappierPageHeaderPlaceholderProps) {
  // The header's own title role: a hero title only without a leading mark (a marked title keeps the page size).
  const lineHeight = happierPageTextMetrics(props.largeTitle && !props.leading ? 'heroTitle' : 'pageTitle').lineHeight;
  return <HappierPageHeader {...props} title={<View style={{ height: lineHeight, justifyContent: 'center' }}>
    <HappierSkeletonBlock width={96} height={10} radius={5} color={color} reducedMotion={reducedMotion} />
  </View>} />;
}
