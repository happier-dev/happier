import { describe, expect, it } from 'vitest';

import {
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionPatchRequestSchema,
  AutomationTriggerCreateRequestSchema,
  AutomationTriggerPatchRequestSchema,
} from './automationApiV3.js';

const executionRecipe = {
  v: 1,
  templateVersion: 1,
  template: { t: 'plain', v: { v: 1, prompt: 'Run.' } },
  triggerEvidence: null,
  target: {
    kind: 'executionRun',
    request: {
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    },
  },
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
            event: 'parentTurnCompleted',
            scope: { kind: 'exactTurn', sourceSessionId: 'session-1', sourceTurnId: 'turn-1' },
            consumption: 'once',
          },
        },
      ],
    });
    expect(parsed.triggers).toHaveLength(2);
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
