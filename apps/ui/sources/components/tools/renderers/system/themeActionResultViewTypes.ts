import type * as React from 'react';
import type {
  ThemeMiniatureData,
  ThemeProfileMode,
} from '@/theme/profiles/themeProfileTypes';

/**
 * Presentation seam of the agent theme card (plan-6 §7 U2): what one `appearance.themes.*` tool result
 * shows in the transcript. The result model (`useThemeActionResultModel`) projects ACTIONS' typed result,
 * the shared try-on owner and the operation outcome into these props; the view decides layout, copy and
 * motion only. No Action ids, schemas or validators live here.
 */

/** A theme as the card draws it: its own miniature from the compact header, never a body. */
export type ThemeResultTheme = Readonly<{
  name: string;
  mode: ThemeProfileMode;
  miniature: ThemeMiniatureData;
  /** True for a theme the agent made in this turn; false for a change to an existing theme. */
  created: boolean;
}>;

/**
 * Where the card's theme stands, one state at a time (finding 2: try first, then Keep).
 * - `trying`: on this device through the shared try-on, nothing saved.
 * - `replaced`: another try took this device's preview; this card no longer drives it.
 * - `reverted`: the try was put back; nothing was saved.
 * - `kept`: Keep saved it to Your themes and selected it here.
 * - `applied`: an existing theme was selected here.
 * - `undone`: the kept or applied change was undone (Redo replays it, R2-4).
 * - `failed`: the named operation failed; the previous state stays as it was.
 */
export type ThemeResultPhase =
  | Readonly<{ kind: 'trying' }>
  | Readonly<{ kind: 'replaced' }>
  | Readonly<{ kind: 'reverted' }>
  | Readonly<{ kind: 'kept' }>
  | Readonly<{ kind: 'applied' }>
  | Readonly<{ kind: 'undone'; restoredName: string | null }>
  | Readonly<{
      kind: 'failed';
      operation: ThemeResultOperation;
      /** The typed Action error code as it arrived (`theme_undo_handle_unknown`, `client_not_connected`…), shown as a quiet fact. */
      code: string | null;
    }>;

export type ThemeResultOperation = 'try' | 'keep' | 'undo' | 'redo' | 'apply';

/** One option of an agent's grouped tries (R2-2): presentation only, fed by the tool group's inputs. */
export type ThemeResultOption = Readonly<{
  key: string;
  name: string;
  /** The agent's one line of character for this option. */
  description: string;
  miniature: ThemeMiniatureData;
}>;

/** CSS coverage counts from the CSS owner's compact result (T6); never derived or reparsed here. */
export type ThemeResultCoverage = Readonly<{
  total: number;
  native: number;
  webOnly: number;
}>;

/**
 * The outcome of applying the kept theme on other connected devices (E2): device labels from the shared
 * client-choice result, one entry per dispatched target. Disconnected devices are never listed (finding 6).
 */
export type ThemeResultDistribution = Readonly<{
  applied: readonly string[];
  failed: readonly Readonly<{
    label: string;
    reason: 'disconnected' | 'failed';
  }>[];
}>;

export type ThemeActionResultViewProps = Readonly<{
  theme: ThemeResultTheme;
  phase: ThemeResultPhase;
  /** An operation in flight (its button shows progress; the others wait). */
  busy: ThemeResultOperation | null;
  /** How this device is named in a status line ("this Mac", "this phone"); from the device label owner. */
  here: string;
  /** B3: the grouped options; the one matching `currentOptionKey` is the one being tried. */
  options?: readonly ThemeResultOption[];
  currentOptionKey?: string | null;
  /** B4: the miniature of what this device showed before, for the before → after comparison. */
  before?: ThemeMiniatureData | null;
  /** Human surface names the CSS reshapes ("session list", "composer"), from `affectedSurfaces`. */
  reshapes?: readonly string[];
  coverage?: ThemeResultCoverage | null;
  /** The web-only rules, once requested through `onRevealWebOnly` (full rules come from get on request). */
  webOnlyRules?: readonly string[] | null;
  /** E4: human surface names the CSS hides on this device, from the CSS owner's `hides`. */
  hides?: readonly string[];
  distribution?: ThemeResultDistribution | null;
  onKeep: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRetry: () => void;
  onTryOption: (key: string) => void;
  /** Absent when the editor cannot open this theme here. */
  onEdit?: () => void;
  /** Opens the shared connected-device picker anchored to the card's button; only offered after Keep. */
  onUseOtherDevices?: () => void;
  onRevealWebOnly?: () => void;
  /** The anchor the device picker opens from (the "Use on other devices…" button). */
  devicesAnchorRef?: React.RefObject<unknown>;
  /** The open device picker, hosted by the card's popover / phone sheet; null when closed. */
  devicePicker?: React.ReactNode;
  /** Closes the device picker (Escape, outside press, the sheet's grabber); never dispatches. */
  onDismissDevices?: () => void;
  testID?: string;
}>;
