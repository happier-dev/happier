import {
  PLUGIN_UI_ICON_TOKENS_V1,
  type PluginUiIconTokenV1,
} from '@happier-dev/plugin-sdk/ui';

/** Protocol-owned semantic vocabulary re-exported through the public SDK UI seam. */
export const HAPPIER_ICON_NAMES = PLUGIN_UI_ICON_TOKENS_V1;

export type HappierIconName = PluginUiIconTokenV1;
export type HappierIconSize = 'small' | 'medium' | 'large';

const ICON_NAME_SET: ReadonlySet<string> = new Set(HAPPIER_ICON_NAMES);
const ICON_SIZE_PX: Readonly<Record<HappierIconSize, number>> = Object.freeze({
  small: 16,
  medium: 20,
  large: 24,
});

export function isHappierIconName(value: unknown): value is HappierIconName {
  return typeof value === 'string' && ICON_NAME_SET.has(value);
}

export function resolveHappierIconSize(size: HappierIconSize = 'medium'): number {
  return ICON_SIZE_PX[size];
}
