import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';

describe('ActionsSettingsV1Schema', () => {
  it('accepts per-action overrides and enforces per-surface + per-placement disablement', async () => {
    const { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } = await import('./actionSettings.js');

    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'review.start': {
          enabled: false,
        },
        'plan.start': {
          disabledSurfaces: ['mcp'],
          disabledPlacements: ['command_palette'],
        },
        'delegate.start': {
          enabledPlacements: ['agent_input_chips'],
        },
        'unknown.action': {
          enabled: false,
        },
      },
    });
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.actions)).toEqual(['review.start', 'plan.start', 'delegate.start']);

    expect(isActionEnabledByActionsSettings('review.start' as any, parsed)).toBe(false);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed)).toBe(true);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed, { surface: 'mcp' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed, { surface: 'ui_button' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed, { placement: 'command_palette' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed, { placement: 'agent_input_chips' } as any)).toBe(false);

    // Opt-in placement: disabled by default unless explicitly enabled.
    expect(isActionEnabledByActionsSettings('delegate.start' as any, parsed, { placement: 'agent_input_chips' } as any)).toBe(true);

    // Ensure action ids remain the canonical ActionId schema.
    expect(() => ActionIdSchema.parse('review.start')).not.toThrow();
  });
});
