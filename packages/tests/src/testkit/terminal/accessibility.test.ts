import { describe, expect, it } from 'vitest';

import {
  TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
  listTerminalNativeAccessibilityDeviceEvidenceRequirements,
} from './accessibility';

describe('terminal native accessibility device requirements', () => {
  it('defines platform-tree, screen-reader, and terminal-affordance evidence without reporting a result', () => {
    const requirements = listTerminalNativeAccessibilityDeviceEvidenceRequirements();

    expect(requirements.map((requirement) => requirement.id)).toEqual(
      TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
    );
    expect(requirements.every((requirement) => requirement.description.length > 0)).toBe(true);
    expect(requirements).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'passed' }),
    ]));
  });
});
