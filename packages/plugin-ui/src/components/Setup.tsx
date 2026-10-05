import type { ReactElement, ReactNode } from 'react';

import { HappierSetupSteps, type HappierSetupStep } from '../presentation/content/SetupSteps.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type SetupStep = HappierSetupStep;
export type SetupStepsProps = Readonly<{ steps: readonly SetupStep[]; plain?: boolean; testID?: string }>;

export function SetupSteps(props: SetupStepsProps): ReactElement {
  const theme = usePluginTheme();
  return <HappierSetupSteps {...props} theme={theme} stateGlyph={<Icon name="check" size="small" tone="success" />} />;
}

export type SetupBlockAction = Readonly<{ label: string; testID: string; onPress(): void }>;
export type SetupBlockTileProps = Readonly<{
  testID: string;
  layout: 'card' | 'row';
  icon?: IconName;
  glyph?: ReactNode;
  title: string;
  subtitle: string;
  action: SetupBlockAction;
  alternative?: SetupBlockAction;
  disabled?: boolean;
  dismiss?: Readonly<{ label: string; tooltip?: string; onPress(): void }>;
  progress?: Readonly<{ fraction: number; accessibilityLabel: string }>;
  fallback?: ReactNode;
}>;

/** Host setup paper and controls; acquisition, progress and dismissal decisions remain yours. */
export function SetupBlockTile({ fallback, ...input }: SetupBlockTileProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderSetupBlockTile?.(input) ?? fallback}</>;
}

export type SetupBlockItem = Readonly<{
  id: string;
  span?: 2 | 'row';
  renderTile(controls: Readonly<{ open(): void }>): ReactNode;
  renderPanel?(controls: Readonly<{ close(): void }>): ReactNode;
}>;
export type SetupBlockGridProps = Readonly<{
  items: readonly SetupBlockItem[];
  columns?: 1 | 2 | 3;
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
  frame?: 'paper' | 'bare';
  testID: string;
  fallback?: ReactNode;
}>;

/** Reuses the host's grid, in-place panel motion, focus and panel mount lifetime. */
export function SetupBlockGrid({ fallback, ...input }: SetupBlockGridProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderSetupBlockGrid?.(input) ?? fallback}</>;
}
