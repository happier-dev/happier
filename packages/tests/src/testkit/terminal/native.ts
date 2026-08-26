import {
  TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
  type TerminalNativeAccessibilityDeviceEvidenceId,
} from './accessibility';
import type { TerminalWorkloadId } from './workloads';

export const TERMINAL_NATIVE_DEVICE_ACTION_IDS = [
  'async-byte-write-ack-reject-retry',
  'hardware-keyboard-chords',
  'ime-composition',
  'selection-copy',
  'renderer-crash-fallback',
  'background-resume',
] as const;

export type TerminalNativeDeviceActionId = typeof TERMINAL_NATIVE_DEVICE_ACTION_IDS[number];
export type TerminalNativeDeviceRenderer = 'ios-ghosttykit' | 'android-termux';
export type TerminalNativeDevicePlatform = 'ios' | 'android';

export type TerminalNativeDeviceRecipe = Readonly<{
  renderer: TerminalNativeDeviceRenderer;
  platform: TerminalNativeDevicePlatform;
  requiredWorkloads: readonly TerminalWorkloadId[];
  requiredActions: readonly TerminalNativeDeviceActionId[];
  requiredAccessibilityEvidence: readonly TerminalNativeAccessibilityDeviceEvidenceId[];
  evidenceSource: 'loaded-native-app';
  hostContractIsDeviceEvidence: false;
}>;

const NATIVE_REQUIRED_WORKLOAD_IDS = [
  'ansi-burst',
  'heavy-tui-redraw',
  'alternate-screen',
  'wide-combining',
  'long-scrollback',
  'link-heavy-output',
  'bracketed-paste-echo',
] as const satisfies readonly TerminalWorkloadId[];

const RECIPES: readonly TerminalNativeDeviceRecipe[] = Object.freeze([
  {
    renderer: 'ios-ghosttykit',
    platform: 'ios',
    requiredWorkloads: NATIVE_REQUIRED_WORKLOAD_IDS,
    requiredActions: TERMINAL_NATIVE_DEVICE_ACTION_IDS,
    requiredAccessibilityEvidence: TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
    evidenceSource: 'loaded-native-app',
    hostContractIsDeviceEvidence: false,
  },
  {
    renderer: 'android-termux',
    platform: 'android',
    requiredWorkloads: NATIVE_REQUIRED_WORKLOAD_IDS,
    requiredActions: TERMINAL_NATIVE_DEVICE_ACTION_IDS,
    requiredAccessibilityEvidence: TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
    evidenceSource: 'loaded-native-app',
    hostContractIsDeviceEvidence: false,
  },
]);

function missingValues<T>(expected: readonly T[], actual: readonly T[]): readonly T[] {
  const present = new Set(actual);
  return expected.filter((value) => !present.has(value));
}

export function listTerminalNativeDeviceRecipes(): readonly TerminalNativeDeviceRecipe[] {
  return RECIPES;
}

export function getTerminalNativeDeviceRecipe(
  renderer: TerminalNativeDeviceRenderer,
): TerminalNativeDeviceRecipe {
  const recipe = RECIPES.find((candidate) => candidate.renderer === renderer);
  if (!recipe) {
    throw new Error('missing terminal native device recipe for ' + renderer);
  }
  return recipe;
}

export function assertTerminalNativeDeviceRecipeCoverage(recipe: TerminalNativeDeviceRecipe): void {
  const missingWorkloads = missingValues(NATIVE_REQUIRED_WORKLOAD_IDS, recipe.requiredWorkloads);
  const missingActions = missingValues(TERMINAL_NATIVE_DEVICE_ACTION_IDS, recipe.requiredActions);
  const missingAccessibility = missingValues(
    TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
    recipe.requiredAccessibilityEvidence,
  );
  if (missingWorkloads.length || missingActions.length || missingAccessibility.length) {
    throw new Error([
      'terminal native device recipe coverage is incomplete',
      missingWorkloads.length ? 'workloads=' + missingWorkloads.join(',') : '',
      missingActions.length ? 'actions=' + missingActions.join(',') : '',
      missingAccessibility.length ? 'accessibility=' + missingAccessibility.join(',') : '',
    ].filter(Boolean).join(' '));
  }
  if (recipe.evidenceSource !== 'loaded-native-app' || recipe.hostContractIsDeviceEvidence) {
    throw new Error('terminal native device recipes must require loaded-app evidence');
  }
}
