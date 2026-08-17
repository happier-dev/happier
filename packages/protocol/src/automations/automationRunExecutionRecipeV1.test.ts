import { describe, expect, it } from 'vitest';

import { deriveAutomationOccurrenceKeyV1 } from './automationOccurrenceV1.js';
import {
  AutomationRunExecutionRecipeV1Schema,
  freezeAutomationRunPluginEventExecutionRecipeV1,
  materializeAutomationRunExecutionRecipeV1,
  materializeAutomationRunPromptV1,
  parseAutomationRunExecutionRecipeV1,
  serializeAutomationRunExecutionRecipeV1,
  validateAutomationRunExecutionRecipeOuterV1,
} from './automationRunExecutionRecipeV1.js';

const pluginEventEvidence = {
  v: 1,
  kind: 'pluginEvent',
  eventRef: {
    pluginId: 'com.example.github',
    localId: 'issue-opened',
  },
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
  occurrenceId: 'occurrence-1',
  occurredAt: 1_700_000_000_000,
  payload: { action: 'opened', issue: { number: 42 } },
  sourceInstanceId: 'repository-acme-example',
  sourceContractVersion: 1,
  observationReceivedAt: 1_700_000_000_100,
  filter: { version: 1, result: 'matched' },
} as const;

describe('materializeAutomationRunPromptV1', () => {
  it('renders every supported input token from frozen Event evidence', () => {
    const materialized = materializeAutomationRunPromptV1({
      template: { v: 1, prompt: 'First {{input}}\nSecond {{input}}' },
      triggerEvidence: pluginEventEvidence,
    });

    expect(materialized).toMatchObject({ kind: 'available' });
    if (materialized.kind !== 'available') return;
    expect(materialized.prompt).toContain('First <automation_input v="1">');
    expect(materialized.prompt).toContain('Second <automation_input v="1">');
    expect(materialized.prompt.match(/payload_json=/g)).toHaveLength(2);
  });

  it('rejects unknown tokens instead of rendering them as authority-free text', () => {
    expect(materializeAutomationRunPromptV1({
      template: { v: 1, prompt: '{{unknown}}' },
      triggerEvidence: pluginEventEvidence,
    })).toEqual({ kind: 'contentInvalid' });
  });

  it('rejects repeated input expansion above the output byte ceiling before materializing it', () => {
    const materialized = materializeAutomationRunPromptV1({
      template: { v: 1, prompt: '{{input}}'.repeat(32) },
      triggerEvidence: {
        ...pluginEventEvidence,
        payload: { value: 'x'.repeat(16_384) },
      },
    });

    expect(materialized).toEqual({ kind: 'contentInvalid' });
  });
});

describe('AutomationRunExecutionRecipeV1', () => {
  const plainCurrentness = {
    mode: 'plain',
    version: 7,
    contentKeyFingerprint: null,
  } as const;
  const plainRecipe = {
    v: 1,
    templateVersion: 4,
    template: {
      t: 'plain',
      v: { v: 1, prompt: 'Summarize this run.' },
    },
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

  it('uses the strict detached execution request and independently mode-matched envelopes', () => {
    expect(AutomationRunExecutionRecipeV1Schema.safeParse(plainRecipe).success).toBe(true);
    expect(validateAutomationRunExecutionRecipeOuterV1({
      recipe: plainRecipe,
      accountCurrentness: plainCurrentness,
    })).toMatchObject({ kind: 'available' });

    expect(AutomationRunExecutionRecipeV1Schema.safeParse({
      ...plainRecipe,
      target: {
        ...plainRecipe.target,
        request: {
          ...plainRecipe.target.request,
          instructions: 'Must be rendered only at dispatch.',
        },
      },
    }).success).toBe(false);
    expect(validateAutomationRunExecutionRecipeOuterV1({
      recipe: {
        ...plainRecipe,
        template: { t: 'encrypted', c: 'opaque' },
      },
      accountCurrentness: plainCurrentness,
    })).toEqual({ kind: 'contentInvalid' });
  });

  it('freezes Event evidence only through the canonical strict definition recipe', () => {
    const definition = serializeAutomationRunExecutionRecipeV1(plainRecipe);
    if (definition.kind !== 'available') throw new Error('fixture recipe must serialize');

    expect(freezeAutomationRunPluginEventExecutionRecipeV1({
      definitionRecipe: definition.serialized,
      templateVersion: plainRecipe.templateVersion,
      triggerEvidence: { t: 'plain', v: { kind: 'pluginEvent' } },
    }).kind).toBe('contentInvalid');

    const evidence = {
      v: 1,
      kind: 'pluginEvent' as const,
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      occurrenceId: 'delivery-1',
      occurredAt: 4,
      payload: { action: 'opened' },
      sourceInstanceId: 'repository-1',
      sourceContractVersion: 1,
      observationReceivedAt: 5,
      filter: { version: null, result: 'matched' as const },
    };
    const frozen = freezeAutomationRunPluginEventExecutionRecipeV1({
      definitionRecipe: definition.serialized,
      templateVersion: plainRecipe.templateVersion,
      triggerEvidence: { t: 'plain', v: evidence },
    });
    expect(frozen).toMatchObject({
      kind: 'available',
      recipe: { triggerEvidence: { t: 'plain', v: evidence } },
    });
  });

  it('accepts encrypted recipe envelopes for an E2EE Account witness', () => {
    const encryptedRecipe = {
      ...plainRecipe,
      template: { t: 'encrypted' as const, c: 'opaque-template' },
    };

    expect(validateAutomationRunExecutionRecipeOuterV1({
      recipe: encryptedRecipe,
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'current-content-key',
      },
    })).toMatchObject({
      kind: 'available',
      recipe: { template: encryptedRecipe.template },
    });
  });

  it('permits bounded encrypted recipe framing above the rendered prompt ceiling', () => {
    expect(AutomationRunExecutionRecipeV1Schema.safeParse({
      ...plainRecipe,
      template: { t: 'encrypted', c: 'A'.repeat(270_000) },
      triggerEvidence: null,
    }).success).toBe(true);
  });

  it('owns bounded strict recipe parsing and canonical persistence serialization', () => {
    const serialized = serializeAutomationRunExecutionRecipeV1(plainRecipe);
    expect(serialized.kind).toBe('available');
    if (serialized.kind !== 'available') return;

    const parsed = parseAutomationRunExecutionRecipeV1(serialized.serialized);
    expect(parsed.kind).toBe('available');
    if (parsed.kind === 'available') {
      expect(parsed.recipe).toEqual(serialized.recipe);
      expect(parsed.serialized).toBe(serialized.serialized);
    }
    expect(parseAutomationRunExecutionRecipeV1('{"v":1,"unexpected":true}')).toEqual({
      kind: 'contentInvalid',
    });
    expect(parseAutomationRunExecutionRecipeV1('not-json')).toEqual({ kind: 'contentInvalid' });
  });

  it('derives new-Session creation identity and initial message only at materialization', () => {
    const recipe = {
      ...plainRecipe,
      target: {
        kind: 'newSession',
        spawn: {
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/work/project',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' },
          },
        },
      },
    } as const;

    const materialized = materializeAutomationRunExecutionRecipeV1({
      recipe,
      origin: { kind: 'manual', invokedAt: 1_700_000_000_000 },
      accountCurrentness: plainCurrentness,
      runId: 'run-42',
    });

    expect(materialized).toMatchObject({
      kind: 'available',
      target: {
        kind: 'newSession',
        spawn: {
          creationKey: 'automation-run:run-42',
          initialMessage: 'Summarize this run.',
        },
      },
    });
    expect(AutomationRunExecutionRecipeV1Schema.safeParse({
      ...recipe,
      target: {
        ...recipe.target,
        spawn: { ...recipe.target.spawn, creationKey: 'caller-created-key' },
      },
    }).success).toBe(false);
  });

  it('rejects a Plugin Event origin whose occurrence key belongs to an otherwise identical occurrence', () => {
    const occurrenceEvidence = {
      v: pluginEventEvidence.v,
      kind: pluginEventEvidence.kind,
      eventRef: pluginEventEvidence.eventRef,
      sourceSelectorId: pluginEventEvidence.sourceSelectorId,
      occurrenceId: pluginEventEvidence.occurrenceId,
      occurredAt: pluginEventEvidence.occurredAt,
      payload: pluginEventEvidence.payload,
    } as const;
    const recipe = {
      ...plainRecipe,
      triggerEvidence: { t: 'plain' as const, v: pluginEventEvidence },
    };
    const matchingOrigin = {
      kind: 'pluginEvent' as const,
      occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
      sourceSelectorId: pluginEventEvidence.sourceSelectorId,
      occurredAt: pluginEventEvidence.occurredAt,
    };
    const differentOccurrence = {
      ...pluginEventEvidence,
      occurrenceId: 'occurrence-2',
    };

    expect(materializeAutomationRunExecutionRecipeV1({
      recipe,
      origin: matchingOrigin,
      accountCurrentness: plainCurrentness,
      runId: 'run-plugin-event',
    })).toMatchObject({ kind: 'available' });
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: {
        ...recipe,
        triggerEvidence: { t: 'plain', v: differentOccurrence },
      },
      origin: matchingOrigin,
      accountCurrentness: plainCurrentness,
      runId: 'run-plugin-event',
    })).toEqual({ kind: 'contentInvalid' });
  });

  it('rejects a Conversation origin whose occurrence key belongs to an otherwise identical occurrence', () => {
    const evidence = {
      v: 1,
      kind: 'conversation' as const,
      bindingId: 'binding-1',
      occurrenceId: 'conversation-occurrence-1',
      occurredAt: 1_700_000_000_000,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        machineId: 'machine-1',
      },
      input: { message: 'hello' },
      replyContextIdentity: 'reply-context-1',
      observationReceivedAt: 1_700_000_000_100,
    };
    const recipe = {
      ...plainRecipe,
      triggerEvidence: { t: 'plain' as const, v: evidence },
    };
    const occurrenceEvidence = {
      v: evidence.v,
      kind: evidence.kind,
      bindingId: evidence.bindingId,
      occurrenceId: evidence.occurrenceId,
      occurredAt: evidence.occurredAt,
      caller: evidence.caller,
      input: evidence.input,
      replyContextIdentity: evidence.replyContextIdentity,
    } as const;
    const matchingOrigin = {
      kind: 'conversation' as const,
      occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
      occurredAt: evidence.occurredAt,
    };
    const differentOccurrence = {
      ...evidence,
      occurrenceId: 'conversation-occurrence-2',
    };

    expect(materializeAutomationRunExecutionRecipeV1({
      recipe,
      origin: matchingOrigin,
      accountCurrentness: plainCurrentness,
      runId: 'run-conversation',
    })).toMatchObject({ kind: 'available' });
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: {
        ...recipe,
        triggerEvidence: { t: 'plain', v: differentOccurrence },
      },
      origin: matchingOrigin,
      accountCurrentness: plainCurrentness,
      runId: 'run-conversation',
    })).toEqual({ kind: 'contentInvalid' });
  });
});
