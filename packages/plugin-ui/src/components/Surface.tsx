import type { ReactElement, ReactNode } from 'react';

import { HappierSurface } from '../presentation/layout/Surface.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type SurfaceTone = 'surface' | 'muted';
export type SurfacePadding = 'none' | 'small' | 'medium' | 'large';

export type SurfaceProps = Readonly<{
  children?: ReactNode;
  tone?: SurfaceTone;
  padding?: SurfacePadding;
  testID?: string;
  onPress?: () => unknown;
  disabled?: boolean;
  /** Required for an actionable surface whose visible content is not its name. */
  accessibilityLabel?: string;
}>;

export type CardProps = SurfaceProps;

const PADDING_BY_SIZE: Readonly<Record<SurfacePadding, Readonly<{
  horizontal: number;
  vertical: number;
}>>> = Object.freeze({
  none: { horizontal: 0, vertical: 0 },
  small: { horizontal: 12, vertical: 10 },
  medium: { horizontal: 16, vertical: 14 },
  large: { horizontal: 20, vertical: 18 },
});

function SurfaceChrome({
  children,
  tone = 'surface',
  padding = 'none',
  testID,
  onPress,
  disabled,
  accessibilityLabel,
}: SurfaceProps): ReactElement {
  const theme = usePluginTheme();
  const inset = PADDING_BY_SIZE[padding];
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
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
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

/** A content surface with the standard card inset. */
export function Card({ padding = 'medium', ...props }: CardProps): ReactElement {
  return <SurfaceChrome {...props} padding={padding} />;
}
