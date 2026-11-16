import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';

/**
 * Presentation seam of the one connected-device picker (plan-6 §7 U2, findings 5–6), shared by the
 * library's in-use slot, the agent card after Keep and the E2 result. `useThemeDevicePicker` projects the
 * shared client-choice result (connected clients only) and the per-target apply outcomes into these props.
 * The view holds no RPC, library subscription or device history.
 */
export type ThemeDevicePickerRow = Readonly<{
  /** The answering client id; stable across renders. */
  id: string;
  /** The registered device label; null when the client registered none. */
  label: string | null;
  /** A computer (laptop/desktop glyph) or a phone/tablet. */
  computer: boolean;
  /** This device: listed first, already wearing the theme, not selectable. */
  current: boolean;
  checked: boolean;
  /** The per-target outcome once Use was pressed; null before. */
  outcome: 'applying' | 'applied' | 'failed' | 'disconnected' | null;
}>;

export type ThemeDevicePickerViewProps = Readonly<{
  themeName: string;
  mode: ThemeProfileMode;
  /** The on-demand discovery read: rows keep their last value while it refreshes. */
  state: 'loading' | 'ready' | 'error';
  rows: readonly ThemeDevicePickerRow[];
  /** True while the selected targets are being applied. */
  dispatching: boolean;
  onToggle: (id: string) => void;
  onUse: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  testID?: string;
}>;
