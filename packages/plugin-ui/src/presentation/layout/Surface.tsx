import { createContext, useContext, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { useOptionalPluginUiPresentationHost } from '../../presentationHost/context.js';
import { happierMaterialBackgroundColor, type HappierMaterialRole } from './material.js';

const MaterialRoleContext = createContext<HappierMaterialRole | undefined>(undefined);

/**
 * Shared structural surface behavior.
 *
 * The app owns its private palette, elevation and material decisions; plugin
 * adapters own their projected semantic chrome. This owner keeps the common
 * native host selection and optional press lifecycle so neither side keeps a
 * second card/action wrapper.
 */
export type HappierSurfaceProps = Readonly<{
  children?: ReactNode;
  testID?: string;
  onPress?: () => unknown;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Semantic group; the host owns its effective material and preference. */
  materialRole?: HappierMaterialRole;
  /** Resolved chrome supplied by the core or plugin adapter. */
  style?: HappierStyleProp;
  /** Hit area/chrome outside the card body for an actionable surface. */
  pressableStyle?: HappierStyleProp;
  /** The surface's place in its parent (e.g. filling a grid cell), for both the static and the actionable host. */
  frameStyle?: HappierStyleProp;
  /** Applied only while the shared press lifecycle reports a real press. */
  pressedStyle?: HappierStyleProp;
}>;

export function HappierSurface({
  children,
  testID,
  onPress,
  disabled,
  accessibilityLabel,
  materialRole,
  style,
  pressableStyle,
  pressedStyle,
  frameStyle,
}: HappierSurfaceProps) {
  const host = useOptionalPluginUiPresentationHost();
  const parentRole = useContext(MaterialRoleContext);
  const nested = parentRole === materialRole;
  const baseColor = Platform.OS === 'web' && materialRole && !host?.renderMaterialSurface
    ? StyleSheet.flatten<HappierPortableStyle>(style)?.backgroundColor
    : undefined;
  const materialStyle = materialRole && typeof baseColor === 'string'
    ? { backgroundColor: happierMaterialBackgroundColor(baseColor, materialRole, Platform.OS === 'web', nested) }
    : undefined;
  const body = materialRole && host?.renderMaterialSurface
    ? host.renderMaterialSurface({ role: materialRole, nested, children, style })
    : <View style={[style, materialStyle]}>{children}</View>;
  const content = <MaterialRoleContext.Provider value={materialRole ?? parentRole}>{body}</MaterialRoleContext.Provider>;

  if (!onPress) {
    return <View testID={testID} style={frameStyle}>{content}</View>;
  }

  return (
    <HappierPressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [frameStyle, pressableStyle, pressed ? pressedStyle : undefined]}
    >
      {content}
    </HappierPressable>
  );
}
