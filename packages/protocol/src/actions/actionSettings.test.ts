import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from './actionSettings.js';

describe('ActionsSettingsV1Schema', () => {
  it('keeps valid sibling policy and fails closed only a malformed known override on tolerant reads', () => {
    const parsed = normalizeActionsSettingsV1({
      v: 1,
      futureRootField: { preservedByThePersistedDocument: true },
      actions: {
        'session.message.send': { enabled: false },
        'session.stop': { disabledSurfaces: 'api' },
        'unknown.action': { enabled: false },
      },
    });

    expect(parsed.actions['session.message.send' as keyof typeof parsed.actions]).toMatchObject({ enabled: false });
    expect(parsed.actions['session.stop' as keyof typeof parsed.actions]).toMatchObject({ enabled: false });
    expect(parsed.actions).not.toHaveProperty('unknown.action');
    expect(isActionEnabledByActionsSettings('session.message.send', parsed)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.stop', parsed)).toBe(false);
  });

  it('accepts per-action overrides and enforces per-surface + per-placement disablement', () => {
    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'review.start': {
          enabled: false,
        },
        'subagents.plan.start': {
          disabledSurfaces: ['mcp'],
          disabledPlacements: ['command_palette'],
          approvalRequiredSurfaces: ['cli'],
          toolExposureModes: {
            agent: 'direct',
            mcp: 'discoverable_only',
          },
        },
        'subagents.delegate.start': {
          disabledSurfaces: ['agent'],
          enabledPlacements: ['agent_input_chips'],
        },
        'unknown.action': {
          enabled: false,
        },
      },
    });
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.actions)).toEqual(['review.start', 'subagents.plan.start', 'subagents.delegate.start']);

    expect(isActionEnabledByActionsSettings('review.start' as any, parsed)).toBe(false);
    expect(isActionEnabledByActionsSettings('subagents.plan.start' as any, parsed)).toBe(true);
    expect(isActionEnabledByActionsSettings('subagents.plan.start' as any, parsed, { surface: 'mcp' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('subagents.plan.start' as any, parsed, { surface: 'ui' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('subagents.plan.start' as any, parsed, { placement: 'command_palette' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('subagents.plan.start' as any, parsed, { placement: 'agent_input_chips' } as any)).toBe(false);

    // Opt-in placement: disabled by default unless explicitly enabled.
    expect(isActionEnabledByActionsSettings('subagents.delegate.start' as any, parsed, { placement: 'agent_input_chips' } as any)).toBe(true);

    // Per-surface disablement should support the agent surface.
    expect(isActionEnabledByActionsSettings('subagents.delegate.start' as any, parsed, { surface: 'agent' } as any)).toBe(false);

    // Ensure action ids remain the canonical ActionId schema.
    expect(() => ActionIdSchema.parse('review.start')).not.toThrow();

    expect(parsed.actions['subagents.plan.start' as keyof typeof parsed.actions].toolExposureModes).toEqual({
      agent: 'direct',
      mcp: 'discoverable_only',
    });
  });

  it('normalizes legacy subagent action ids to the new persisted ids', () => {
    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'plan.start': {
          disabledPlacements: ['command_palette'],
        },
        'delegate.start': {
          enabledPlacements: ['agent_input_chips'],
        },
      },
    });

    expect(parsed.actions['subagents.plan.start' as keyof typeof parsed.actions]).toEqual({
      enabledPlacements: [],
      disabledSurfaces: [],
      disabledPlacements: ['command_palette'],
      approvalRequiredSurfaces: [],
      toolExposureModes: {},
    });
    expect(parsed.actions['subagents.delegate.start' as keyof typeof parsed.actions]).toEqual({
      enabledPlacements: ['agent_input_chips'],
      disabledSurfaces: [],
      disabledPlacements: [],
      approvalRequiredSurfaces: [],
      toolExposureModes: {},
    });
  });

  it('collapses legacy implementation-specific surface overrides to broad final surfaces', () => {
    const legacyUiButton = `ui_${'button'}`;
    const legacyUiSlash = `ui_${'slash_command'}`;
    const legacyVoiceTool = `voice_${'tool'}`;
    const legacyVoiceBlock = `voice_${'action_block'}`;
    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'review.start': {
          disabledSurfaces: [legacyUiButton, legacyUiSlash, legacyVoiceTool, legacyVoiceBlock, 'mcp', 'unknown_surface'],
          approvalRequiredSurfaces: [legacyVoiceTool, 'cli'],
        },
      },
    });

    expect(parsed.actions['review.start' as keyof typeof parsed.actions]).toEqual({
      enabledPlacements: [],
      disabledSurfaces: ['ui', 'voice', 'mcp'],
      disabledPlacements: [],
      approvalRequiredSurfaces: ['voice', 'cli'],
      toolExposureModes: {},
    });
    expect(isActionEnabledByActionsSettings('review.start' as any, parsed, { surface: 'ui' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('review.start' as any, parsed, { surface: 'voice' } as any)).toBe(false);
  });

  it('filters tool exposure settings to supported tool surfaces and modes', () => {
    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          toolExposureModes: {
            agent: 'direct',
            mcp: 'discoverable_only',
            cli: 'direct',
            ui: 'direct',
            voice: 'discoverable_only',
            unknown: 'direct',
            session_control_cli: 'direct',
            badMode: 'hidden',
          },
        },
      },
    });

    expect(parsed.actions['subagents.delegate.start' as keyof typeof parsed.actions].toolExposureModes).toEqual({
      agent: 'direct',
      mcp: 'discoverable_only',
      cli: 'direct',
    });
  });

  it('retains a canonical qualified contributed-Action identity as a settings key', () => {
    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'acme.notes/actions/save-note': {
          disabledSurfaces: ['api'],
        },
      },
    });

    expect(parsed.actions['acme.notes/actions/save-note' as keyof typeof parsed.actions]).toEqual({
      enabledPlacements: [],
      disabledSurfaces: ['api'],
      disabledPlacements: [],
      approvalRequiredSurfaces: [],
      toolExposureModes: {},
    });
  });
});
