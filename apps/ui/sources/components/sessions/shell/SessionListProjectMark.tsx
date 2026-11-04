import * as React from 'react';
import { Image, Platform, View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Path } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import type { WorkspaceFavicon } from '@/sync/ops/workspaceFavicon';

/**
 * The badge's place on a mark of `size` (lab `.ls-mk2`): a 0.6 badge overhanging the bottom-right
 * corner by a fifth, cut out of the mark with a hairline of clearance so it reads on any row paint.
 */
export function resolveSessionListProjectMarkBadgeGeometry(size: number, badgeScale = 0.6) {
  const badge = Math.round(size * badgeScale);
  const overhang = Math.round(size * 0.2);
  const center = size + overhang - badge / 2;
  const radius = badge / 2 + size * 0.075;
  return { badge, overhang, center, radius };
}

/**
 * The Project-led leading mark (P5 `clctx:marks`): the Project's favicon, or the folder fallback when
 * there is none, with the Agent as a small badge cut out of its corner (a mask, never a tile).
 */
export function SessionListProjectMark(
  props: Readonly<{
    favicon: WorkspaceFavicon | null;
    size: number;
    badge: React.ReactNode | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { size } = props;
  const mark = props.favicon ? (
    <Image
      testID={props.testID ? `${props.testID}-project-favicon` : undefined}
      source={{ uri: props.favicon.uri }}
      style={{ width: size, height: size, borderRadius: Math.round(size / 4) }}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
    />
  ) : (
    <View
      testID={props.testID ? `${props.testID}-project-fallback` : undefined}
    >
      <Icon name="folder" size={size} color={theme.colors.text.tertiary} />
    </View>
  );
  return <SessionListMarkBadge size={size} badge={props.badge}>{mark}</SessionListMarkBadge>;
}

/**
 * Any leading mark with a small badge cut out of one corner (a mask, never a tile). The Project mark's Agent
 * badge and the coordinator sub-badge share this one geometry; `corner` keeps two badges off each other.
 */
export function SessionListMarkBadge(
  props: Readonly<{
    size: number;
    badge: React.ReactNode | null;
    corner?: 'bottomRight' | 'topRight';
    /** The badge's share of the mark; a large mark (the Avatar) takes a smaller one so the badge stays a sub-mark. */
    badgeScale?: number;
    children: React.ReactNode;
  }>,
) {
  const { size } = props;
  if (!props.badge) {
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.children}
      </View>
    );
  }
  const geometry = resolveSessionListProjectMarkBadgeGeometry(size, props.badgeScale);
  const top = props.corner === 'topRight';
  const centerY = top ? geometry.badge / 2 - geometry.overhang : geometry.center;
  return (
    <View style={{ width: size, height: size }}>
      <SessionListProjectMarkCutout
        size={size}
        centerX={geometry.center}
        centerY={centerY}
        radius={geometry.radius}
      >
        {props.children}
      </SessionListProjectMarkCutout>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: -geometry.overhang,
          ...(top ? { top: -geometry.overhang } : { bottom: -geometry.overhang }),
          width: geometry.badge,
          height: geometry.badge,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.badge}
      </View>
    </View>
  );
}

function SessionListProjectMarkCutout(
  props: Readonly<{
    size: number;
    centerX: number;
    centerY: number;
    radius: number;
    children: React.ReactNode;
  }>,
) {
  const { size, centerX, centerY, radius } = props;
  if (Platform.OS === 'web') {
    // Half a pixel of feather, as the lab's gradient stop pair.
    const mask = `radial-gradient(circle at ${centerX}px ${centerY}px, transparent ${radius - 0.25}px, #000 ${radius + 0.25}px)`;
    return (
      <View
        style={[
          {
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
          },
          { maskImage: mask, WebkitMaskImage: mask } as object,
        ]}
      >
        {props.children}
      </View>
    );
  }
  // The mask is opaque everywhere but the badge's disc (even-odd: the square minus the circle).
  const hole = `M0 0H${size}V${size}H0Z M${centerX - radius} ${centerY}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0Z`;
  return (
    <MaskedView
      style={{ width: size, height: size }}
      maskElement={
        <Svg width={size} height={size}>
          <Path d={hole} fill="#000" fillRule="evenodd" />
        </Svg>
      }
    >
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.children}
      </View>
    </MaskedView>
  );
}
