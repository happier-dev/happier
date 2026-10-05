import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { actionSpecToActionDefinitionV1, serializeActionSpec } from './actionCatalog.js';
import { actionCliDerivedDefault } from './actionCliProjection.js';
import {
  ActionSpecSchema,
  getActionSpec,
  listActionCliCommandDeclarations,
  type ActionSpec,
} from './actionSpecs.js';

const CallerSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  run: z.string().min(1).optional(),
}).strict();

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'session.message.send',
    title: 'Send a message',
    safety: 'safe',
    approval: { result: 'none' },
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
      api: false,
      plugin: false,
    },
    inputSchema: CallerSchema,
    ...overrides,
  };
}

describe('ActionSpec.cli declaration', () => {
  it('projects the landed explanation lifecycle through canonical friendly CLI commands', () => {
    const commands = listActionCliCommandDeclarations();
    for (const [id, path] of [
      ['scm.diffSummary.capture', ['scm', 'diff-summary', 'capture']],
      ['scm.diffSummary.generate', ['scm', 'diff-summary', 'generate']],
      ['scm.diffSummary.result.edit', ['scm', 'diff-summary', 'result', 'edit']],
      ['scm.diffSummary.result.undo', ['scm', 'diff-summary', 'result', 'undo']],
      ['scm.diffSummary.result.delete', ['scm', 'diff-summary', 'result', 'delete']],
      ['scm.diffSummary.refine', ['scm', 'diff-summary', 'refine']],
      ['scm.diffSummary.addOutputs', ['scm', 'diff-summary', 'add-outputs']],
      ['scm.diffSummary.discuss', ['scm', 'diff-summary', 'discuss']],
      ['scm.diffSummary.reviewed.mark', ['scm', 'diff-summary', 'reviewed', 'mark']],
    ] as const) {
      expect(commands.some((entry) => entry.spec.id === id && entry.binding.path.join(' ') === path.join(' ')), id).toBe(true);
    }
  });
  it('accepts a friendly path with positionals drawn from the caller shape', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: {
        commands: [
          { path: ['session', 'send'], positionals: ['sessionId', 'message'] },
          { path: ['send'], positionals: ['sessionId', 'message'], visibility: 'alias' },
        ],
        flagAliases: [{ path: 'message', aliases: ['--prompt'] }],
      },
    }));
    expect(parsed.success).toBe(true);
  });

  it('rejects a friendly path on an Action that is not CLI-surfaced', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      surfaces: {
        ui: false, voice: false, agent: false, mcp: false,
        cli: false, rpc: false, api: false, plugin: false,
      },
      cli: { commands: [{ path: ['send'] }] },
    }));
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message))
      .toContain('cli requires surface.cli');
  });

  it('rejects a positional that is not a field of the effective caller schema', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['send'], positionals: ['sessionId', 'nope'] }] },
    }));
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toContain(
      'cli positional "nope" is not a field of the effective CLI caller schema',
    );
  });

  it('checks positionals against the declared CLI caller schema, not canonical input', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      // `run` exists only on the caller shape; the binder turns it into a recipient.
      inputSchema: z.object({ sessionId: z.string(), message: z.string() }).strict(),
      cli: {
        commands: [{ path: ['send'], positionals: ['sessionId', 'message', 'run'] }],
        inputSchema: CallerSchema,
        bindInput: (value: unknown) => value,
      },
    }));
    expect(parsed.success).toBe(true);
  });

  it('rejects a binder without a declared caller schema', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['send'] }], bindInput: (value: unknown) => value },
    }));
    expect(parsed.success).toBe(false);
  });

  it('rejects the same positional twice in one command', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['send'], positionals: ['message', 'message'] }] },
    }));
    expect(parsed.success).toBe(false);
  });

  it('accepts one declared variadic positional from the effective caller shape', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: {
        commands: [{ path: ['actions', 'search'], variadicPositional: 'message' }],
      },
    }));
    expect(parsed.success).toBe(true);
  });

  it('rejects a variadic positional that is missing or also fixed', () => {
    const missing = ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['actions', 'search'], variadicPositional: 'nope' }] },
    }));
    expect(missing.success).toBe(false);
    expect(missing.success ? [] : missing.error.issues.map((issue) => issue.message)).toContain(
      'cli variadic positional "nope" is not a field of the effective CLI caller schema',
    );

    const duplicate = ActionSpecSchema.safeParse(baseSpec({
      cli: {
        commands: [{
          path: ['actions', 'search'],
          positionals: ['message'],
          variadicPositional: 'message',
        }],
      },
    }));
    expect(duplicate.success).toBe(false);
  });

  it('rejects a flag alias declared for two fields', () => {
    const parsed = ActionSpecSchema.safeParse(baseSpec({
      cli: {
        commands: [{ path: ['send'] }],
        flagAliases: [
          { path: 'message', aliases: ['--prompt'] },
          { path: 'run', aliases: ['--prompt'] },
        ],
      },
    }));
    expect(parsed.success).toBe(false);
  });

  it('rejects command segments that are not the safe kebab-case grammar', () => {
    expect(ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['Session', 'send'] }] },
    })).success).toBe(false);
    expect(ActionSpecSchema.safeParse(baseSpec({
      cli: { commands: [{ path: ['--send'] }] },
    })).success).toBe(false);
  });

  it('does not publish the friendly CLI projection over Action discovery', () => {
    const spec: ActionSpec = {
      ...getActionSpec('session.message.send'),
      cli: { commands: [{ path: ['send'], positionals: ['sessionId', 'message'] }] },
    };
    expect(serializeActionSpec(spec)).not.toHaveProperty('cli');
    expect(actionSpecToActionDefinitionV1(spec)).not.toHaveProperty('cli');
  });

  it('exposes every declared friendly path once, with one owning Action', () => {
    const declarations = listActionCliCommandDeclarations();
    const paths = declarations.map(({ binding }) => binding.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('projects the established execution-run leaves through the Action-owned CLI declarations', () => {
    const byPath = new Map(
      listActionCliCommandDeclarations().map(({ spec, binding }) => [binding.path.join(' '), spec.id]),
    );
    expect([...byPath.entries()].filter(([path]) => path.startsWith('session run '))).toEqual(
      expect.arrayContaining([
        ['session run list', 'execution.run.list'],
        ['session run get', 'execution.run.get'],
        ['session run start', 'execution.run.start'],
        ['session run stop', 'execution.run.stop'],
        ['session run wait', 'execution.run.wait'],
        ['session run stream-start', 'execution.run.stream.start'],
        ['session run stream-read', 'execution.run.stream.read'],
        ['session run stream-cancel', 'execution.run.stream.cancel'],
      ]),
    );
  });

  it('projects Action discovery through the existing actions command host', () => {
    const byPath = new Map(
      listActionCliCommandDeclarations().map(({ spec, binding }) => [binding.path.join(' '), spec.id]),
    );
    expect(byPath.get('actions search')).toBe('action.spec.search');
    expect(byPath.get('actions get')).toBe('action.spec.get');
    expect(() => ActionSpecSchema.parse(getActionSpec('action.spec.search'))).not.toThrow();
    expect(() => ActionSpecSchema.parse(getActionSpec('action.spec.get'))).not.toThrow();
  });

  it('binds friendly execution-run start defaults and exact Agent spellings without host lookup', () => {
    const spec = getActionSpec('execution.run.start');
    const callerSchema = spec.cli?.inputSchema;
    const bindInput = spec.cli?.bindInput;
    expect(callerSchema).toBeDefined();
    expect(bindInput).toBeDefined();

    const review = callerSchema!.parse({
      sessionId: 'session-prefix',
      intent: 'review',
      agent: 'agent:happier.agent.codex/codex',
    });
    expect(bindInput!(review, {
      actionId: 'execution.run.start',
      invocationId: 'invocation-1',
    })).toEqual({
      sessionId: 'session-prefix',
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      // Intent-derived run shape is the binder's own default, stated as such so a
      // canonical whole-input JSON value for the same field is preserved.
      permissionMode: actionCliDerivedDefault('read_only'),
      retentionPolicy: actionCliDerivedDefault('ephemeral'),
      runClass: actionCliDerivedDefault('bounded'),
      ioMode: actionCliDerivedDefault('request_response'),
    });

    const external = callerSchema!.parse({
      sessionId: 'session-prefix',
      intent: 'delegate',
      agent: 'agent:com.acme.review/review-bot',
      instructions: 'Review this change.',
    });
    expect(bindInput!(external, {
      actionId: 'execution.run.start',
      invocationId: 'invocation-2',
    })).toEqual(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'com.acme.review/review-bot',
        sourceKind: 'built_in',
      },
      permissionMode: actionCliDerivedDefault('workspace_write'),
    }));

    // This friendly command selects one execution target. The comma grammar
    // belongs to older multi-target workflows and must fail before credentials
    // or Action dispatch instead of becoming a made-up built-in Agent id.
    expect(callerSchema!.safeParse({
      sessionId: 'session-prefix',
      intent: 'review',
      agent: 'claude,codex',
    }).success).toBe(false);
  });
});
