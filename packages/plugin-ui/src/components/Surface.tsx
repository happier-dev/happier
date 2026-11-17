import type { SurfaceAddress } from '@happier-dev/plugin-sdk/ui';
import type { ReactElement, ReactNode } from 'react';

import { HappierSurface, type HappierFloatingRole } from '../presentation/layout/Surface.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import type { HappierMaterialRole } from '../presentation/layout/material.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { SURFACE_PADDING_BY_SIZE } from './surfacePadding.js';

export type SurfaceTone = 'surface' | 'muted';
export type SurfacePadding = 'none' | 'small' | 'medium' | 'large';

export type SurfaceProps = Readonly<{
  themeSurface?: SurfaceAddress;
  children?: ReactNode;
  tone?: SurfaceTone;
  padding?: SurfacePadding;
  /** The host's material group. Surface uses content; Card uses the in-flow card group. */
  materialRole?: HappierMaterialRole;
  /** Read only by a `floating` material: `panel` takes the heavy coat of a dialog or large panel, `menu` (the default) a menu's hair. */
  floatingRole?: HappierFloatingRole;
  testID?: string;
  onPress?: () => unknown;
  disabled?: boolean;
  /** Required for an actionable surface whose visible content is not its name. */
  accessibilityLabel?: string;
}>;

export type CardProps = SurfaceProps;


function SurfaceChrome({
  themeSurface,
  children,
  tone = 'surface',
  padding = 'none',
  testID,
  onPress,
  disabled,
  accessibilityLabel,
  materialRole = 'content',
  floatingRole,
}: SurfaceProps): ReactElement {
  const theme = usePluginTheme();
  const inset = SURFACE_PADDING_BY_SIZE[padding];
  const contentStyle: HappierPortableStyle = {
    width: '100%',
    minWidth: 0,
    borderRadius: theme.radii.panel,
    backgroundColor: tone === 'muted' ? theme.colors.elevatedSurface : theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: inset.horizontal,
    paddingVertical: inset.vertical,
  };

  return (
    <HappierSurface
      themeSurface={themeSurface}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      materialRole={materialRole}
      floatingRole={floatingRole}
      style={contentStyle}
      pressableStyle={{ width: '100%', borderRadius: theme.radii.panel }}
      pressedStyle={{ opacity: 0.985 }}
    >
      {children}
    </HappierSurface>
  );
}

/** A semantic content surface with no implicit interior spacing. */
export function Surface(props: SurfaceProps): ReactElement {
  return <SurfaceChrome {...props} />;
}

/** An in-flow card surface with the standard inset. */
export function Card({ padding = 'medium', ...props }: CardProps): ReactElement {
  return <SurfaceChrome {...props} materialRole={props.materialRole ?? 'card'} padding={padding} />;
}
