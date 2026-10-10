import { describe, expect, it } from 'vitest';

import {
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionPatchRequestSchema,
  AutomationTriggerCreateRequestSchema,
  AutomationTriggerPatchRequestSchema,
} from './automationApiV3.js';

const executionRecipe = {
  v: 2,
  templateVersion: 1,
  triggerEvidence: null,
  workflow: { t: 'plain', v: {
    workspace: { directory: '/repo' },
    executionTarget: { kind: 'detached_run' },
    inlineDefinition: {
      version: 1,
      inputs: [],
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        permissionMode: 'read-only' },
      blocks: [{ kind: 'step', id: 'step', document: { text: 'Run.', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }],
    },
  } },
} as const;

describe('Automation trigger-set API', () => {
  it('creates one Automation with zero or multiple automatic triggers', () => {
    const base = {
      automationId: 'automation-operations',
      name: 'Operations',
      enabled: true,
      executionRecipe,
      triggers: [],
    };
    expect(AutomationDefinitionCreateRequestSchema.parse(base).triggers).toEqual([]);

    const parsed = AutomationDefinitionCreateRequestSchema.parse({
      ...base,
      triggers: [
        {
          triggerId: 'trigger-schedule',
          trigger: {
            kind: 'schedule',
            enabled: true,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
          },
        },
        {
          triggerId: 'trigger-session-lifecycle',
          trigger: {
            kind: 'sessionLifecycle',
            enabled: true,
            sourceSessionId: 'session-1',
            events: ['parentTurnCompleted', 'userActionRequired'],
            policy: { kind: 'nextMatches', count: 3 },
          },
        },
      ],
    });
    expect(parsed.triggers).toHaveLength(2);
    expect(parsed.triggers[1]?.trigger).toMatchObject({
      events: ['parentTurnCompleted', 'userActionRequired'],
      policy: { kind: 'nextMatches', count: 3 },
    });
  });

  it('keeps lifecycle Event sets strict and policies explicit', () => {
    const base = {
      triggerId: 'trigger-session-lifecycle',
      trigger: {
        kind: 'sessionLifecycle',
        enabled: true,
        sourceSessionId: 'session-1',
        events: ['parentTurnFailed'],
      },
    } as const;

    expect(AutomationTriggerCreateRequestSchema.parse({
      ...base,
      trigger: { ...base.trigger, policy: { kind: 'currentTurn', sourceTurnId: 'turn-1' } },
    }).trigger).toMatchObject({ policy: { kind: 'currentTurn', sourceTurnId: 'turn-1' } });
    expect(AutomationTriggerCreateRequestSchema.parse({
      ...base,
      trigger: { ...base.trigger, policy: { kind: 'firstMatch' } },
    }).trigger).toMatchObject({ policy: { kind: 'firstMatch' } });
    expect(AutomationTriggerCreateRequestSchema.parse({
      ...base,
      trigger: { ...base.trigger, policy: { kind: 'everyMatch' } },
    }).trigger).toMatchObject({ policy: { kind: 'everyMatch' } });
    expect(AutomationTriggerCreateRequestSchema.safeParse({
      ...base,
      trigger: { ...base.trigger, events: [], policy: { kind: 'firstMatch' } },
    }).success).toBe(false);
    expect(AutomationTriggerCreateRequestSchema.safeParse({
      ...base,
      trigger: {
        ...base.trigger,
        events: ['parentTurnFailed', 'parentTurnFailed'],
        policy: { kind: 'firstMatch' },
      },
    }).success).toBe(false);
    expect(AutomationTriggerCreateRequestSchema.safeParse({
      ...base,
      trigger: { ...base.trigger, policy: { kind: 'nextMatches', count: 0 } },
    }).success).toBe(false);
    expect(AutomationTriggerCreateRequestSchema.safeParse({
      ...base,
      trigger: {
        kind: 'sessionLifecycle',
        enabled: true,
        event: 'parentTurnCompleted',
        scope: { kind: 'exactTurn', sourceSessionId: 'session-1', sourceTurnId: 'turn-1' },
        consumption: 'once',
      },
    }).success).toBe(false);
  });

  it('has no persisted manual trigger and patches triggers by stable identity and revision', () => {
    expect(AutomationTriggerCreateRequestSchema.safeParse({
      triggerId: 'trigger-manual',
      trigger: { kind: 'manual', enabled: true },
    }).success).toBe(false);

    expect(AutomationTriggerPatchRequestSchema.parse({
      triggerId: 'trigger-1',
      expectedRevision: 4,
      enabled: false,
    })).toMatchObject({ triggerId: 'trigger-1', expectedRevision: 4, enabled: false });

    expect(AutomationDefinitionPatchRequestSchema.safeParse({
      expectedTemplateVersion: 2,
      triggers: [],
    }).success).toBe(false);
  });
});
