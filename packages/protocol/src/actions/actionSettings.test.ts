import { describe, expect, it, vi } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { PromptRegistryInstallInputSchema } from './actionSpecs.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from './actionSettings.js';

describe('ActionsSettingsV1Schema', () => {
  it('refuses foreign Session HTML Actions by default without changing the own-Session UI policy', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
    const foreign = { surface: 'ui' as const, callerSurface: 'foreign_session_html' as const };
    for (const actionId of ['session.message.send', 'session.stop'] as const) {
      expect(isActionEnabledByActionsSettings(actionId, settings, foreign)).toBe(false);
      expect(isActionEnabledByActionsSettings(actionId, settings, { surface: 'ui' })).toBe(true);
    }
  });
  it('retains predecessor agent policy through the production Account reader', async () => {
    const [{ accountSettingsParse }, { isApprovalRequiredByActionsSettings }, { resolveActionToolExposureMode }, { getActionSpec }] = await Promise.all([
      import('../account/settings/accountSettings.js'),
      import('./actionApprovalPolicy.js'),
      import('./actionToolExposure.js'),
      import('./actionSpecs.js'),
    ]);
    // Serialized by ../0.2 ActionsSettingsV1Schema.parse at clean HEAD
    // 2761f397736b040394caecf7cbe57a44f31e4d6c; the live producer replay also
    // verifies this retained vector, rather than reconstructing an old schema.
    const predecessor = { v: 1, actions: {
      'session.open': {
        enabled: true, enabledPlacements: [], disabledSurfaces: ['cli'], disabledPlacements: [],
        approvalRequiredSurfaces: ['session_agent'], toolExposureModes: { session_agent: 'direct' },
      },
      'session.stop': {
        enabled: true, enabledPlacements: [], disabledSurfaces: ['session_agent'], disabledPlacements: [],
        approvalRequiredSurfaces: [], toolExposureModes: {},
      },
    } };
    const settings = accountSettingsParse({ actionsSettingsV1: JSON.parse(JSON.stringify(predecessor)) }).actionsSettingsV1;

    expect(settings.actions['session.open']).toMatchObject({
      enabled: true, disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['agent'], toolExposureModes: { agent: 'direct' },
    });
    expect(isApprovalRequiredByActionsSettings('session.open', settings, { surface: 'agent' })).toBe(true);
    expect(isActionEnabledByActionsSettings('session.open', settings, { surface: 'agent' })).toBe(true);
    expect(isActionEnabledByActionsSettings('session.open', settings, { surface: 'cli' })).toBe(false);
    expect(isActionEnabledByActionsSettings('session.stop', settings, { surface: 'agent' })).toBe(false);
    expect(resolveActionToolExposureMode(getActionSpec('session.open'), 'agent', { settings })).toBe('direct');
    expect(normalizeActionsSettingsV1(settings)).toEqual(settings);
  });

  it('prefers valid current tool exposure over the predecessor alias in either field order', () => {
    for (const toolExposureModes of [
      { session_agent: 'direct', agent: 'discoverable_only' },
      { agent: 'discoverable_only', session_agent: 'direct' },
    ]) {
      const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.open': { toolExposureModes } } });
      expect(settings.actions['session.open'].toolExposureModes).toEqual({ agent: 'discoverable_only' });
    }
  });

  it('accepts a predecessor registry install target without granting a native export', async () => {
    expect(PromptRegistryInstallInputSchema.parse({ machineId: 'machine', sourceId: 'source', itemId: 'item',
      installTarget: { assetTypeId: 'claude.skill', scope: 'user', targetName: 'skill' } }))
      .toEqual({ machineId: 'machine', sourceId: 'source', itemId: 'item' });
  });
  it('retains the predecessor Export override without resolving it to a current Action', () => {
    const row = { enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [],
      approvalRequiredSurfaces: [], toolExposureModes: {}, futurePolicy: { mode: 'ask' } };
    const parsed = normalizeActionsSettingsV1({ v: 1, actions: { 'prompt_asset.export': row } });
    expect(parsed.actions['prompt_asset.export']).toEqual(row);
    expect(normalizeActionsSettingsV1(parsed).actions['prompt_asset.export']).toEqual(row);
    expect(ActionIdSchema.safeParse('prompt_asset.export').success).toBe(false);
  });
  it('initializes the Action id and Account policy module graph together', async () => {
    vi.resetModules();
    const [{ ActionIdSchema: actionIdSchema }, { accountSettingsParse }] = await Promise.all([
      import('./actionIds.js'),
      import('../account/settings/accountSettings.js'),
    ]);

    expect(actionIdSchema.parse('session.stop')).toBe('session.stop');
    expect(accountSettingsParse({}).actionsSettingsV1.v).toBe(1);
  });

  it('keeps valid sibling policy and fails closed only a malformed known override on tolerant reads', () => {
    const parsed = normalizeActionsSettingsV1({
      v: 1,
      futureRootField: { preservedByThePersistedDocument: true },
      actions: {
        'session.message.send': { enabled: false },
        'session.stop': { disabledSurfaces: 'api' },
        'unknown.action': { enabled: false, futurePolicy: { mode: 'ask' } },
      },
    });

    expect(parsed.actions['session.message.send' as keyof typeof parsed.actions]).toMatchObject({ enabled: false });
    expect(parsed.actions['session.stop' as keyof typeof parsed.actions]).toMatchObject({ enabled: false });
    expect(parsed.actions['unknown.action']).toMatchObject({ enabled: false, futurePolicy: { mode: 'ask' } });
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
    expect(Object.keys(parsed.actions)).toEqual(['review.start', 'subagents.plan.start', 'subagents.delegate.start', 'unknown.action']);

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
