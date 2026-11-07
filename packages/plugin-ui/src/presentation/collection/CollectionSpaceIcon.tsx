import * as React from 'react';
import { Image, View } from 'react-native';

/** The held mark, with no Account selection or acquisition behind rendering it. */
export type HappierCollectionSpaceMark =
  | Readonly<{ kind: 'icon'; glyph: React.ReactNode }>
  | Readonly<{ kind: 'project'; favicon: Readonly<{ uri: string }> | null; fallback: React.ReactNode }>;

export type HappierCollectionSpaceIconProps = Readonly<{
  mark: HappierCollectionSpaceMark;
  size: number;
  testID?: string;
}>;

/** A Space's glyph or held Project favicon; a missing favicon remains a folder without starting a read. */
export const HappierCollectionSpaceIcon = React.memo(function HappierCollectionSpaceIcon(props: HappierCollectionSpaceIconProps) {
  if (props.mark.kind === 'icon') return <>{props.mark.glyph}</>;
  if (!props.mark.favicon) return <View testID={props.testID ? `${props.testID}-project-fallback` : undefined}>{props.mark.fallback}</View>;
  return <View style={{ width: props.size, height: props.size, alignItems: 'center', justifyContent: 'center' }}>
    <Image testID={props.testID ? `${props.testID}-project-favicon` : undefined}
      source={{ uri: props.mark.favicon.uri }} style={{ width: props.size, height: props.size, borderRadius: Math.round(props.size / 4) }}
      resizeMode="cover" accessibilityIgnoresInvertColors />
  </View>;
});
