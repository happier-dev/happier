import { View } from 'react-native';
import { HappierSkeletonBlock } from '../feedback/Skeleton.js';
import { HappierPageHeader, type HappierPageHeaderProps } from './PageHeader.js';
import { happierPageTextMetrics } from './pageText.js';

export type HappierPageHeaderPlaceholderProps = Pick<HappierPageHeaderProps,
  'testID' | 'showTitle' | 'largeTitle' | 'columnMaxWidthPx' | 'renderText'> & Readonly<{
  color: string;
  reducedMotion?: boolean;
}>;

/** The page header's own geometry, reserving its title line before the destination is known. */
export function HappierPageHeaderPlaceholder({ color, reducedMotion, ...props }: HappierPageHeaderPlaceholderProps) {
  const lineHeight = happierPageTextMetrics(props.largeTitle ? 'heroTitle' : 'pageTitle').lineHeight;
  return <HappierPageHeader {...props} title={<View style={{ height: lineHeight, justifyContent: 'center' }}>
    <HappierSkeletonBlock width={96} height={10} radius={5} color={color} reducedMotion={reducedMotion} />
  </View>} />;
}
