import { HappierAvatarStack, type HappierAvatarStackProps } from '../presentation/content/AvatarStack.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type { HappierAvatarStackEntry as AvatarStackEntry } from '../presentation/content/AvatarStack.js';
export type AvatarStackProps = Omit<HappierAvatarStackProps, 'ringColor'> & Readonly<{ ringColor?: string }>;

/** Overlapping identity marks, optionally contained in one row-leading slot. */
export function AvatarStack(props: AvatarStackProps) {
  const theme = usePluginTheme();
  return <HappierAvatarStack {...props} ringColor={props.ringColor ?? theme.colors.surface} />;
}
