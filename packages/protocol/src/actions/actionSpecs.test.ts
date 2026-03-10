import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ExecutionRunIntentSchema } from '../executionRuns.js';
import { ActionSpecSchema, getActionSpec, isActionSpecSurfacedOn, listActionSpecs, listActionSpecsForSurface, listVoicePromptHotPathSpecs } from './actionSpecs.js';

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

  it('binds voice teleport to teleportVoiceAgentToSessionRoot', () => {
    const spec = getActionSpec('ui.voice_agent.teleport');
    expect(spec.bindings?.voiceClientToolName).toBe('teleportVoiceAgentToSessionRoot');
    expect(spec.surfaces.voice_tool).toBe(true);
    expect(spec.surfaces.voice_action_block).toBe(true);
  });

  it('exposes memory action specs', () => {
    const spec = getActionSpec('memory.search');
    expect(spec.id).toBe('memory.search');
    expect(spec.surfaces.voice_tool).toBe(true);
  });

  it('exposes session fork action spec', () => {
    const spec = getActionSpec('session.fork');
    expect(spec.id).toBe('session.fork');
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.placements).toContain('session_action_menu');
  });

  it('exposes session open action spec', () => {
    const spec = getActionSpec('session.open');
    expect(spec.id).toBe('session.open');
    expect(spec.surfaces.ui_button).toBe(true);
    expect(spec.placements).toContain('command_palette');
    expect(spec.placements).toContain('session_info');
  });

  it('treats approval decisions as danger-class actions', () => {
    const spec = getActionSpec('approval.request.decide');
    expect(spec.safety).toBe('danger');
  });

  it('exposes prompt library mutation actions for approval workflows', () => {
    expect(getActionSpec('prompt_doc.update').safety).toBe('danger');
    expect(getActionSpec('prompt_bundle.update').safety).toBe('danger');
    expect(getActionSpec('prompt_asset.export').safety).toBe('danger');
    expect(getActionSpec('prompt_registry.install').safety).toBe('danger');
  });

  it('accepts installMode for prompt asset export and registry install actions', () => {
    const exportParsed = getActionSpec('prompt_asset.export').inputSchema.parse({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'agents.skill',
      scope: 'project',
      directory: '/tmp/project',
      targetName: 'reviewer',
      installMode: 'symlink',
    });
    const registryParsed = getActionSpec('prompt_registry.install').inputSchema.parse({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'reviewer',
        installMode: 'symlink',
      },
    });

    expect(exportParsed.installMode).toBe('symlink');
    expect(registryParsed.installTarget?.installMode).toBe('symlink');
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

  it('accepts disabled static options in input hints', () => {
    const parsed = ActionSpecSchema.parse({
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
            path: 'engineId',
            title: 'Engine',
            widget: 'select',
            options: [
              { value: 'codex', label: 'Codex' },
              { value: 'legacy', label: 'Legacy', disabled: true },
            ],
          },
        ],
      },
    });

    expect(parsed.inputHints?.fields[0]?.options).toEqual([
      { value: 'codex', label: 'Codex' },
      { value: 'legacy', label: 'Legacy', disabled: true },
    ]);
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
    const plan = getActionSpec('subagents.plan.start');
    const delegate = getActionSpec('subagents.delegate.start');

    expect(plan.surfaces.ui_button).toBe(true);
    expect(delegate.surfaces.ui_button).toBe(true);

    const planFields = (plan as any).inputHints?.fields ?? null;
    const delegateFields = (delegate as any).inputHints?.fields ?? null;

    expect(Array.isArray(planFields)).toBe(true);
    expect(Array.isArray(delegateFields)).toBe(true);

    expect(planFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(planFields.map((f: any) => f.path)).toContain('instructions');
    expect(delegateFields.map((f: any) => f.path)).toContain('backendTargetKeys');
    expect(delegateFields.map((f: any) => f.path)).toContain('instructions');
  });

  it('defaults delegate start permission mode to workspace_write', () => {
    const spec = getActionSpec('subagents.delegate.start');
    const parsed = (spec.inputSchema as any).parse({
      backendTargetKeys: ['agent:codex'],
      instructions: 'Do it.',
    });
    expect(parsed.permissionMode).toBe('workspace_write');
  });

  it('defaults voice agent start to long-lived streaming', () => {
    const spec = getActionSpec('voice_agent.start');
    const parsed = (spec.inputSchema as any).parse({
      backendTargetKeys: ['agent:codex'],
      instructions: 'Voice.',
    });
    expect(parsed.runClass).toBe('long_lived');
    expect(parsed.ioMode).toBe('streaming');
  });

  it('filters action specs by surfaced availability', () => {
    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'voice_tool')).toBe(true);
    expect(isActionSpecSurfacedOn(getActionSpec('session.mode.set'), 'mcp')).toBe(false);
    expect(listActionSpecsForSurface('mcp').some((spec) => spec.id === 'session.mode.set')).toBe(false);
    expect(listActionSpecsForSurface('voice_tool').some((spec) => spec.id === 'session.mode.set')).toBe(true);
  });

  it('derives the voice prompt hot-path inventory from ActionSpec metadata', () => {
    const hotPathIds = listVoicePromptHotPathSpecs().map((spec) => spec.id);

    expect(hotPathIds).toContain('action.spec.search');
    expect(hotPathIds).toContain('session.mode.set');
    expect(hotPathIds).toContain('subagents.plan.start');
    expect(hotPathIds).toContain('subagents.delegate.start');
    expect(hotPathIds).not.toContain('memory.get_window');
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
    expect(byVoiceToolName.has('answerUserActionRequest')).toBe(true);
    expect(byVoiceToolName.has('setPrimaryActionSession')).toBe(true);
    expect(byVoiceToolName.has('setTrackedSessions')).toBe(true);
    expect(byVoiceToolName.has('listSessions')).toBe(true);
    expect(byVoiceToolName.has('getSessionActivity')).toBe(true);
    expect(byVoiceToolName.has('getSessionRecentMessages')).toBe(true);
    expect(byVoiceToolName.has('teleportVoiceAgentToSessionRoot')).toBe(true);

    // Inventory + discovery tools (safe by default; may be gated by user settings in the UI).
    expect(byVoiceToolName.has('spawnSessionPicker')).toBe(true);
    expect(byVoiceToolName.has('listRecentWorkspaces')).toBe(true);
    expect(byVoiceToolName.has('listRecentPaths')).toBe(true);
    expect(byVoiceToolName.has('listMachines')).toBe(true);
    expect(byVoiceToolName.has('listServers')).toBe(true);
    expect(byVoiceToolName.has('listReviewEngines')).toBe(true);
    expect(byVoiceToolName.has('listAgentBackends')).toBe(true);
    expect(byVoiceToolName.has('listAgentModels')).toBe(true);
  });

  it('uses concrete schema-shaped voice args examples for all voice surfaces', () => {
    const placeholderFragments = ['...optional...', '"..."', 'allow|deny', '...|null'];

    for (const spec of listActionSpecs().filter((entry) => entry.surfaces.voice_tool || entry.surfaces.voice_action_block)) {
      const argsExample = spec.examples?.voice?.argsExample;
      expect(typeof argsExample).toBe('string');
      const exampleText = String(argsExample ?? '').trim();
      expect(exampleText.length).toBeGreaterThan(0);
      for (const fragment of placeholderFragments) {
        expect(exampleText).not.toContain(fragment);
      }

      const parsedJson = JSON.parse(exampleText);
      expect((spec.inputSchema as any).safeParse(parsedJson).success).toBe(true);
    }
  });
});
