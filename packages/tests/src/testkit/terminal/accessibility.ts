export const TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS = [
  'platform-accessibility-tree',
  'screen-reader-navigation',
  'copy-selection-link-affordances',
] as const;

export type TerminalNativeAccessibilityDeviceEvidenceId =
  typeof TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS[number];

export type TerminalNativeAccessibilityDeviceEvidenceRequirement = Readonly<{
  id: TerminalNativeAccessibilityDeviceEvidenceId;
  description: string;
}>;

const REQUIREMENTS: readonly TerminalNativeAccessibilityDeviceEvidenceRequirement[] = Object.freeze([
  {
    id: 'platform-accessibility-tree',
    description: 'Inspect the loaded native surface in the platform accessibility tree for useful terminal content or actions.',
  },
  {
    id: 'screen-reader-navigation',
    description: 'Use the platform screen reader to reach current output or the host-provided terminal summary.',
  },
  {
    id: 'copy-selection-link-affordances',
    description: 'Verify copy, selection, and open-link affordances remain reachable through the native accessibility model.',
  },
]);

export function listTerminalNativeAccessibilityDeviceEvidenceRequirements(): readonly TerminalNativeAccessibilityDeviceEvidenceRequirement[] {
  return REQUIREMENTS;
}
