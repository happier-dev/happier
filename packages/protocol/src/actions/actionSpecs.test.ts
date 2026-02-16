import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ExecutionRunIntentSchema } from '../executionRuns.js';
import { ActionSpecSchema, getActionSpec, listActionSpecs } from './actionSpecs.js';

describe('Action Spec Registry', () => {
  it('exposes stable action specs', () => {
    const all = listActionSpecs();
    expect(all.length).toBeGreaterThan(0);
    for (const spec of all) {
      // Runtime safety: registry objects must validate against the schema.
      ActionSpecSchema.parse(spec);
    }
  });

  it('finds known action specs by id', () => {
    const spec = getActionSpec('execution.run.list');
    expect(spec.id).toBe('execution.run.list');
    expect(spec.surfaces.voice_tool).toBe(true);
  });

  it('does not expose de-surfaced legacy execution.run.start action', () => {
    expect(() => getActionSpec('execution.run.start' as any)).toThrow();
  });

  it('does not expose legacy voice_mediator intent in ExecutionRunIntentSchema', () => {
    expect(ExecutionRunIntentSchema.safeParse('voice_agent').success).toBe(true);
    expect(ExecutionRunIntentSchema.safeParse('voice_mediator').success).toBe(false);
  });

  it('binds global voice reset to resetGlobalVoiceAgent', () => {
    const spec = getActionSpec('ui.voice_global.reset');
    expect(spec.bindings?.voiceClientToolName).toBe('resetGlobalVoiceAgent');
  });

  it('exposes memory action specs', () => {
    const spec = getActionSpec('memory.search');
    expect(spec.id).toBe('memory.search');
    expect(spec.surfaces.voice_tool).toBe(true);
  });

  it('provides input hints for every ActionSpec (single source of truth for elicitation)', () => {
    for (const spec of listActionSpecs()) {
      expect((spec as any).inputHints).toBeTruthy();
      expect(Array.isArray((spec as any).inputHints?.fields)).toBe(true);
    }
  });

  it('validates ActionSpec inputHints when present', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          session_control_cli: true,
        },
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'engineIds',
              title: 'Engines',
              widget: 'not-a-widget',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('requires select/multiselect hints to declare options or optionsSourceId', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          session_control_cli: true,
        },
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'select',
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          session_control_cli: true,
        },
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'multiselect',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('requires text_list hints to declare a listSeparator', () => {
    expect(() =>
      ActionSpecSchema.parse({
        id: 'review.start',
        title: 'Start review',
        safety: 'safe',
        placements: [],
        surfaces: {
          ui_button: true,
          ui_slash_command: true,
          voice_tool: true,
          voice_action_block: true,
          mcp: true,
          session_control_cli: true,
        },
        inputSchema: z.object({}).strict(),
        inputHints: {
          fields: [
            {
              path: 'x',
              title: 'X',
              widget: 'text_list',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('provides input hints for intent start actions surfaced as drafts', () => {
    const plan = getActionSpec('plan.start');
    const delegate = getActionSpec('delegate.start');

    expect(plan.surfaces.ui_button).toBe(true);
    expect(delegate.surfaces.ui_button).toBe(true);

    const planFields = (plan as any).inputHints?.fields ?? null;
    const delegateFields = (delegate as any).inputHints?.fields ?? null;

    expect(Array.isArray(planFields)).toBe(true);
    expect(Array.isArray(delegateFields)).toBe(true);

    expect(planFields.map((f: any) => f.path)).toContain('backendIds');
    expect(planFields.map((f: any) => f.path)).toContain('instructions');
    expect(delegateFields.map((f: any) => f.path)).toContain('backendIds');
    expect(delegateFields.map((f: any) => f.path)).toContain('instructions');
  });

  it('defaults delegate start permission mode to workspace_write', () => {
    const spec = getActionSpec('delegate.start');
    const parsed = (spec.inputSchema as any).parse({
      backendIds: ['codex'],
      instructions: 'Do it.',
    });
    expect(parsed.permissionMode).toBe('workspace_write');
  });

  it('defaults voice agent start to long-lived streaming', () => {
    const spec = getActionSpec('voice_agent.start');
    const parsed = (spec.inputSchema as any).parse({
      backendIds: ['codex'],
      instructions: 'Voice.',
    });
    expect(parsed.runClass).toBe('long_lived');
    expect(parsed.ioMode).toBe('streaming');
  });

  it('exposes core voice session controls as voice surfaces', () => {
    const all = listActionSpecs();
    const byVoiceToolName = new Map(
      all
        .filter((spec) => spec.surfaces.voice_tool && Boolean(spec.bindings?.voiceClientToolName))
        .map((spec) => [spec.bindings!.voiceClientToolName!, spec] as const),
    );

    // Baseline expectations: these must exist so local voice and realtime voice can share one tool surface.
    expect(byVoiceToolName.has('sendSessionMessage')).toBe(true);
    expect(byVoiceToolName.has('processPermissionRequest')).toBe(true);
    expect(byVoiceToolName.has('setPrimaryActionSession')).toBe(true);
    expect(byVoiceToolName.has('setTrackedSessions')).toBe(true);
    expect(byVoiceToolName.has('listSessions')).toBe(true);
    expect(byVoiceToolName.has('getSessionActivity')).toBe(true);
    expect(byVoiceToolName.has('getSessionRecentMessages')).toBe(true);

    // Inventory + discovery tools (safe by default; may be gated by user settings in the UI).
    expect(byVoiceToolName.has('spawnSessionPicker')).toBe(true);
    expect(byVoiceToolName.has('listRecentWorkspaces')).toBe(true);
    expect(byVoiceToolName.has('listRecentPaths')).toBe(true);
    expect(byVoiceToolName.has('listMachines')).toBe(true);
    expect(byVoiceToolName.has('listServers')).toBe(true);
    expect(byVoiceToolName.has('listAgentBackends')).toBe(true);
    expect(byVoiceToolName.has('listAgentModels')).toBe(true);
  });
});
