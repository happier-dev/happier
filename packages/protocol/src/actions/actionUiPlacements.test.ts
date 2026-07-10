import { describe, expect, it } from 'vitest';

import { ACTION_UI_PLACEMENTS, ActionUiPlacementSchema } from './actionUiPlacements.js';

describe('action UI placements', () => {
  it('registers the browser context as a typed action invocation placement', () => {
    expect(ACTION_UI_PLACEMENTS).toContain('browser_context');
    expect(ActionUiPlacementSchema.parse('browser_context')).toBe('browser_context');
  });
});
