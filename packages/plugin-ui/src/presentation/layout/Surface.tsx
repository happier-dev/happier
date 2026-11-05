import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import type { HappierPortableStyle, HappierStyleProp, HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { useOptionalPluginUiPresentationHost, type PluginUiPresentationHost } from '../../presentationHost/context.js';
import { happierMaterialBackgroundColor, happierMaterialInnerBackgroundColor, type HappierMaterialRole } from './material.js';
import { happierSurfaceGradientWebStyle, happierSurfaceFinishLift, resolveHappierSurfaceFinish, type HappierSurfaceGradient, type HappierSurfaceFinishRole } from './material.js';
import { HappierSurfaceGradientLayer } from './SurfaceGradientLayer.js';
import { useOptionalHappierUiTheme, useOptionalHappierUiPlatform } from '../../environment/context.js';
import type { HappierRaisedEdgeState } from './raisedEdge.js';

type HappierMaterialPlane = Readonly<{ role?: HappierMaterialRole; finish: boolean; translucentColor?: string; resolveMaterialColor?: PluginUiPresentationHost['resolveMaterialColor']; openedOver?: true }>;
const MaterialRoleContext = createContext<HappierMaterialPlane | null>(null);
export function useContainingHappierMaterialRole(): HappierMaterialRole | undefined {
  return useContext(MaterialRoleContext)?.role;
}

/** Host planes and shared surfaces publish the same containing material, never another preference owner. */
export function HappierMaterialRoleProvider(props: Readonly<Omit<HappierMaterialPlane, 'finish'> & { finish?: boolean; children?: ReactNode }>) {
  const parent = useContext(MaterialRoleContext);
  const { role, finish = parent?.finish ?? false, translucentColor = parent?.translucentColor, resolveMaterialColor = parent?.resolveMaterialColor } = props;
  const plane = useMemo(() => ({ role, finish, translucentColor, resolveMaterialColor }), [role, finish, translucentColor, resolveMaterialColor]);
  return <MaterialRoleContext.Provider value={plane}>{props.children}</MaterialRoleContext.Provider>;
}

/**
 * The boundary of a floating layer (a popover, a menu, a field's choices) opened from inside a surface. Context
 * flows through the layer's portal, but the layer is not in that surface's flow: a surface directly in it is never
 * nested in the opener's material or finish, whatever it asks. The host's popover owner places it.
 */
export function HappierOpenedLayer(props: Readonly<{ children?: ReactNode }>) {
  const parent = useContext(MaterialRoleContext);
  const plane = useMemo(() => parent ? { ...parent, openedOver: true as const } : null, [parent]);
  return plane ? <MaterialRoleContext.Provider value={plane}>{props.children}</MaterialRoleContext.Provider> : <>{props.children}</>;
}

/** Descendant paint. Solid control roles keep their own fill and contrasting ink on every plane. */
export function useHappierMaterialColorResolver() {
  const plane = useContext(MaterialRoleContext);
  const host = useOptionalPluginUiPresentationHost();
  const theme = useOptionalHappierUiTheme();
  const resolver = plane?.resolveMaterialColor ?? (Platform.OS === 'web' ? undefined : host?.resolveMaterialColor);
  const role = plane?.role;
  const defaultTranslucentColor = plane?.translucentColor ?? theme?.colors.divider ?? 'transparent';
  return useCallback((color: string, translucentColor = defaultTranslucentColor, paintRole: 'surface' | 'solidControl' = 'surface') => {
    // Intent cannot be inferred from a colour value: a field and a primary may share it.
    if (paintRole === 'solidControl') return color;
    if (role === undefined) return color;
    if (Platform.OS === 'web' && color.startsWith('var(--happier-glass-')) return color;
    return resolver?.({ color, role, nested: true, translucentColor })
      ?? happierMaterialInnerBackgroundColor(color, translucentColor, role, Platform.OS === 'web');
  }, [role, resolver, defaultTranslucentColor]);
}

/**
 * A floating surface's job: a `panel` (a dialog, sheet or large anchored panel) carries the page at a
 * heavy coat; a `menu` (the default: menus, tooltips, small popovers) keeps a hair of tint.
 */
export type HappierFloatingRole = 'menu' | 'panel';

export type HappierMaterialSurfaceRender = (input: Readonly<{
  role: HappierMaterialRole;
  /** Keep the material host and its children mounted, without painting a coat or establishing a new plane. */
  noCoat?: boolean;
  finishRole?: HappierSurfaceFinishRole;
  floatingRole?: HappierFloatingRole;
  nested?: boolean;
  children?: ReactNode;
  style?: HappierStyleProp;
  testID?: string;
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  accessibilityLabel?: string;
  gradient?: HappierSurfaceGradient | null;
}>) => ReactNode;

/** The material body shared by frames, sheets and actionable surfaces; it keeps their original root. */
export function HappierMaterialSurface(props: Omit<HappierSurfaceProps, 'onPress' | 'pressableStyle' | 'frameStyle' | 'pressedStyle'>) {
  const host = useOptionalPluginUiPresentationHost();
  const renderMaterial = props.renderMaterialSurface ?? host?.renderMaterialSurface;
  const parent = useContext(MaterialRoleContext);
  const theme = useOptionalHappierUiTheme();
  const dark = useOptionalHappierUiPlatform()?.colorScheme === 'dark';
  const nested = parent?.openedOver !== true && (props.nested ?? (props.materialRole !== undefined && parent?.role === props.materialRole));
  const finishRole = props.finishRole ?? (props.materialRole === 'floating' ? 'floating' : 'card');
  const gradient = resolveHappierSurfaceFinish({ role: finishRole,
    gradients: props.gradient === undefined ? (props.materialRole ? theme?.surfaceFinish ?? {} : {}) : { [finishRole]: props.gradient },
    state: { ...props.state, disabled: props.disabled || props.state?.disabled }, nested: nested && parent?.finish === true });
  const flat = StyleSheet.flatten<HappierPortableStyle>(props.style);
  const materialStyle = theme && props.materialRole && typeof flat?.backgroundColor === 'string' && !renderMaterial
    ? { backgroundColor: happierMaterialBackgroundColor(flat.backgroundColor, props.materialRole, Platform.OS === 'web', nested) }
    : undefined;
  const body = renderMaterial
    ? renderMaterial({ role: props.materialRole ?? 'card', ...(props.materialRole === undefined ? { noCoat: true } : {}), finishRole, floatingRole: props.floatingRole, gradient, nested, children: props.children, style: props.style, testID: props.testID, onLayout: props.onLayout, accessibilityLabel: props.accessibilityLabel })
    : <View testID={props.testID} onLayout={props.onLayout} accessibilityLabel={props.accessibilityLabel} style={[props.style, materialStyle, happierSurfaceFinishLift(gradient, finishRole, dark, Platform.OS === 'web'), Platform.OS === 'web' ? happierSurfaceGradientWebStyle(gradient, !dark) : null]}>
        <HappierSurfaceGradientLayer gradient={gradient} borderRadius={typeof flat?.borderRadius === 'number' ? flat.borderRadius : undefined} />
        {props.children}
      </View>;
  const role = props.materialRole ?? parent?.role;
  const hasFinish = Boolean(gradient) || Boolean(nested && parent?.finish);
  const plane = useMemo(() => {
    // Surfaces inside this one are in its flow again.
    const { openedOver: _openedOver, ...inFlow } = parent ?? { finish: false };
    return { ...inFlow, role, finish: hasFinish };
  }, [parent, role, hasFinish]);
  return <MaterialRoleContext.Provider value={plane}>{body}</MaterialRoleContext.Provider>;
}

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
  state?: HappierRaisedEdgeState;
  accessibilityLabel?: string;
  /** Semantic group; the host owns its effective material and preference. */
  materialRole?: HappierMaterialRole;
  /** An independently floating plane does not inherit its containing surface's coat. */
  nested?: boolean;
  finishRole?: HappierSurfaceFinishRole;
  /** Only a `floating` material reads it: the host decides the coat of a menu or a panel. */
  floatingRole?: HappierFloatingRole;
  gradient?: HappierSurfaceGradient | null;
  /** A core adapter binds its existing material owner without installing unrelated plugin services. */
  renderMaterialSurface?: HappierMaterialSurfaceRender;
  onLayout?: (event: HappierLayoutChangeEvent) => void;
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
  nested,
  finishRole,
  floatingRole,
  gradient: suppliedGradient,
  renderMaterialSurface,
  onLayout,
  style,
  pressableStyle,
  pressedStyle,
  frameStyle,
}: HappierSurfaceProps) {
  const content = <HappierMaterialSurface materialRole={materialRole} nested={nested} finishRole={finishRole} floatingRole={floatingRole} gradient={suppliedGradient} renderMaterialSurface={renderMaterialSurface} disabled={disabled} style={style}>{children}</HappierMaterialSurface>;

  if (!onPress) {
    return <View testID={testID} onLayout={onLayout} accessibilityLabel={accessibilityLabel} style={frameStyle}>{content}</View>;
  }

  return (
    <HappierPressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [frameStyle, pressableStyle, pressed ? pressedStyle : undefined]}
    >
      {state => <HappierMaterialSurface materialRole={materialRole} nested={nested} finishRole={finishRole} floatingRole={floatingRole} gradient={suppliedGradient} renderMaterialSurface={renderMaterialSurface} state={state} style={style}>{children}</HappierMaterialSurface>}
    </HappierPressable>
  );
}
