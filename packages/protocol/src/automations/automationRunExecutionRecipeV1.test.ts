import { describe, expect, it } from 'vitest';

import { deriveAutomationOccurrenceKeyV1 } from './automationOccurrenceV1.js';
import {
  AutomationRunExecutionRecipeV1Schema,
  AutomationStoredDefinitionExecutionRecipeV1Schema,
  AutomationRunTemplateV1Schema,
  automationRunExecutionTargetDeliversComposerReferencesV1,
  validateAutomationRunTemplateForExecutionTargetV1,
  freezeAutomationRunPluginEventExecutionRecipeV1,
  inspectAutomationStoredDefinitionExecutionRecipeOuterV1,
  materializeAutomationRunExecutionRecipeV1,
  materializeAutomationRunPromptV1,
  parseAutomationRunExecutionRecipeV1,
  parseAutomationStoredDefinitionExecutionRecipeV1,
  serializeAutomationRunExecutionRecipeV1,
  serializeAutomationStoredDefinitionExecutionRecipeV1,
  validateAutomationRunExecutionRecipeOuterV1,
  validateAutomationStoredDefinitionExecutionRecipeOuterV1,
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
    expect(materialized.prompt).toContain('cause_kind="pluginEvent"');
    expect(materialized.prompt).not.toContain('origin_kind=');
    expect(materialized.prompt.match(/payload_json=/g)).toHaveLength(2);
  });

  it('rejects unknown tokens instead of rendering them as authority-free text', () => {
    expect(materializeAutomationRunPromptV1({
      template: { v: 1, prompt: '{{unknown}}' },
      triggerEvidence: pluginEventEvidence,
    })).toEqual({
      kind: 'contentInvalid',
      reason: 'unsupportedToken',
      token: '{{unknown}}',
    });
  });

  it('names a malformed token separately from an unsupported one', () => {
    expect(materializeAutomationRunPromptV1({
      template: { v: 1, prompt: 'closing }} first' },
      triggerEvidence: null,
    })).toEqual({ kind: 'contentInvalid', reason: 'malformedToken' });
  });

  it('rejects repeated input expansion above the output byte ceiling before materializing it', () => {
    const materialized = materializeAutomationRunPromptV1({
      template: { v: 1, prompt: '{{input}}'.repeat(32) },
      triggerEvidence: {
        ...pluginEventEvidence,
        payload: { value: 'x'.repeat(16_384) },
      },
    });

    expect(materialized).toEqual({
      kind: 'contentInvalid',
      reason: 'materializedInputTooLarge',
    });
  });

  it('names an invalid template separately from an invalid trigger evidence', () => {
    expect(materializeAutomationRunPromptV1({
      template: { v: 1, prompt: 42 },
      triggerEvidence: null,
    })).toEqual({ kind: 'contentInvalid', reason: 'templateInvalid' });
    expect(materializeAutomationRunPromptV1({
      template: { v: 1, prompt: 'ok' },
      triggerEvidence: { kind: 'pluginEvent' },
    })).toEqual({ kind: 'contentInvalid', reason: 'triggerEvidenceInvalid' });
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
    assignmentMachineIds: [],
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
    const { assignmentMachineIds: _frozenAssignments, ...storedRecipe } = plainRecipe;
    const definition = serializeAutomationStoredDefinitionExecutionRecipeV1(storedRecipe);
    if (definition.kind !== 'available') throw new Error('fixture recipe must serialize');

    expect(AutomationStoredDefinitionExecutionRecipeV1Schema.safeParse(storedRecipe).success)
      .toBe(true);
    expect(AutomationStoredDefinitionExecutionRecipeV1Schema.safeParse(plainRecipe).success)
      .toBe(false);
    expect(AutomationRunExecutionRecipeV1Schema.safeParse(storedRecipe).success).toBe(false);
    expect(parseAutomationStoredDefinitionExecutionRecipeV1(definition.serialized).kind)
      .toBe('available');
    expect(parseAutomationRunExecutionRecipeV1(definition.serialized)).toEqual({
      kind: 'contentInvalid',
    });

    expect(freezeAutomationRunPluginEventExecutionRecipeV1({
      definitionRecipe: definition.serialized,
      templateVersion: plainRecipe.templateVersion,
      triggerEvidence: { t: 'plain', v: { kind: 'pluginEvent' } },
      assignmentMachineIds: ['machine-a'],
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
      assignmentMachineIds: ['machine-a', 'machine-b'],
    });
    expect(frozen).toMatchObject({
      kind: 'available',
      recipe: {
        triggerEvidence: { t: 'plain', v: evidence },
        assignmentMachineIds: ['machine-a', 'machine-b'],
      },
    });
  });

  it('inspects stored Definition mode without accepting Run-only frozen facts', () => {
    const { assignmentMachineIds: _frozenAssignments, ...storedRecipe } = plainRecipe;
    const canonicalStoredRecipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse(storedRecipe);
    expect(inspectAutomationStoredDefinitionExecutionRecipeOuterV1({
      recipe: storedRecipe,
      accountCurrentness: plainCurrentness,
    })).toEqual({ kind: 'available', recipe: canonicalStoredRecipe });
    expect(inspectAutomationStoredDefinitionExecutionRecipeOuterV1({
      recipe: storedRecipe,
      accountCurrentness: {
        mode: 'e2ee', version: 8, contentKeyFingerprint: 'content-key',
      },
    })).toEqual({ kind: 'modeMismatch' });
    expect(validateAutomationStoredDefinitionExecutionRecipeOuterV1({
      recipe: storedRecipe,
      accountCurrentness: {
        mode: 'e2ee', version: 8, contentKeyFingerprint: 'content-key',
      },
    })).toEqual({ kind: 'contentInvalid' });
    for (const recipe of [
      plainRecipe,
      { ...storedRecipe, triggerEvidence: { t: 'plain', v: pluginEventEvidence } },
    ]) {
      expect(inspectAutomationStoredDefinitionExecutionRecipeOuterV1({
        recipe,
        accountCurrentness: plainCurrentness,
      })).toEqual({ kind: 'contentInvalid' });
    }
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
      cause: { kind: 'manual', invokedAt: 1_700_000_000_000 },
      accountCurrentness: plainCurrentness,
      runId: 'run-42',
    });

    expect(materialized).toMatchObject({
      kind: 'available',
      target: {
        kind: 'newSession',
        spawn: {
          creationKey: 'automation-run:run-42',
          initialInput: { text: 'Summarize this run.' },
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

  it('rejects a Plugin Event cause whose occurrence key belongs to an otherwise identical occurrence', () => {
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
    const matchingCause = {
      kind: 'trigger' as const,
      triggerId: 'trigger-plugin-event',
      triggerRevision: 1,
      triggerKind: 'pluginEvent' as const,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({
        triggerId: 'trigger-plugin-event',
        evidence: occurrenceEvidence,
      }),
      occurredAt: pluginEventEvidence.occurredAt,
      evidence: {
        eventRef: pluginEventEvidence.eventRef,
        sourceSelectorId: pluginEventEvidence.sourceSelectorId,
      },
    };
    const differentOccurrence = {
      ...pluginEventEvidence,
      occurrenceId: 'occurrence-2',
    };

    expect(materializeAutomationRunExecutionRecipeV1({
      recipe,
      cause: matchingCause,
      accountCurrentness: plainCurrentness,
      runId: 'run-plugin-event',
    })).toMatchObject({ kind: 'available' });
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: {
        ...recipe,
        triggerEvidence: { t: 'plain', v: differentOccurrence },
      },
      cause: matchingCause,
      accountCurrentness: plainCurrentness,
      runId: 'run-plugin-event',
    })).toEqual({ kind: 'contentInvalid' });
  });

  it('rejects a Conversation cause whose occurrence key belongs to an otherwise identical occurrence', () => {
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
    const matchingCause = {
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
      cause: matchingCause,
      accountCurrentness: plainCurrentness,
      runId: 'run-conversation',
    })).toMatchObject({ kind: 'available' });
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: {
        ...recipe,
        triggerEvidence: { t: 'plain', v: differentOccurrence },
      },
      cause: matchingCause,
      accountCurrentness: plainCurrentness,
      runId: 'run-conversation',
    })).toEqual({ kind: 'contentInvalid' });
  });
});

describe('Automation Run template composer references', () => {
  const sessionMention = {
    kind: 'happier.session',
    ref: 'session:sess-42',
    token: '@Nightly%20review',
    label: 'Nightly review',
  } as const;

  it('materializes the admitted references beside the rendered existing-session prompt', () => {
    const materialized = materializeAutomationRunExecutionRecipeV1({
      recipe: {
        v: 1,
        templateVersion: 2,
        assignmentMachineIds: [],
        template: {
          t: 'plain',
          v: {
            v: 1,
            prompt: 'Continue @Nightly%20review with {{input}}',
            mentions: [sessionMention],
          },
        },
        triggerEvidence: null,
        target: { kind: 'existingSession', sessionId: 'sess-target' },
      },
      cause: { kind: 'manual', invokedAt: 5 },
      accountCurrentness: { mode: 'plain', version: 3, contentKeyFingerprint: null },
      runId: 'run-1',
    });

    expect(materialized).toMatchObject({
      kind: 'available',
      target: { kind: 'existingSession', sessionId: 'sess-target', mentions: [sessionMention] },
    });
  });

  it('drops a reference whose token the rendered program no longer contains', () => {
    const materialized = materializeAutomationRunPromptV1({
      template: {
        v: 1,
        prompt: 'The picked token was deleted.',
        mentions: [sessionMention],
      },
      triggerEvidence: null,
    });

    expect(materialized).toMatchObject({ kind: 'available', mentions: [] });
  });

  it('keeps the template strict while accepting the additive reference list', () => {
    expect(AutomationRunTemplateV1Schema.safeParse({
      v: 1,
      prompt: 'ok',
      mentions: [sessionMention],
    }).success).toBe(true);
    expect(AutomationRunTemplateV1Schema.safeParse({
      v: 1,
      prompt: 'ok',
      mentions: [{ ...sessionMention, ref: 'not-a-reference-grammar' }],
    }).success).toBe(false);
    expect(AutomationRunTemplateV1Schema.safeParse({
      v: 1,
      prompt: 'ok',
      unknownField: 1,
    }).success).toBe(false);
  });

  it('rejects identity-bearing references for targets without structured-input delivery', () => {
    const prompt = 'Continue @Nightly%20review now.';
    const targets = [
      { kind: 'existingSession', sessionId: 'sess-target' },
      {
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
      {
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
    ] as const;

    for (const target of targets) {
      const recipe = {
          v: 1,
          templateVersion: 2,
          assignmentMachineIds: [],
          template: { t: 'plain', v: { v: 1, prompt, mentions: [sessionMention] } },
          triggerEvidence: null,
          target,
        } as const;
      const admitted = validateAutomationRunTemplateForExecutionTargetV1({
        template: recipe.template.v,
        target,
      });
      const materialized = materializeAutomationRunExecutionRecipeV1({
        recipe,
        cause: { kind: 'manual', invokedAt: 5 },
        accountCurrentness: { mode: 'plain', version: 3, contentKeyFingerprint: null },
        runId: 'run-1',
      });
      const supported = automationRunExecutionTargetDeliversComposerReferencesV1(target.kind);
      expect(admitted.kind).toBe(supported ? 'available' : 'contentInvalid');
      expect(AutomationRunExecutionRecipeV1Schema.safeParse(recipe).success).toBe(supported);
      expect(materialized.kind).toBe(supported ? 'available' : 'contentInvalid');
    }
  });

  it('rejects unsupported encrypted references after opening private content', () => {
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: {
        v: 1,
        templateVersion: 2,
        assignmentMachineIds: [],
        template: { t: 'encrypted', c: 'ciphertext' },
        triggerEvidence: null,
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
      },
      cause: { kind: 'manual', invokedAt: 5 },
      accountCurrentness: { mode: 'e2ee', version: 3, contentKeyFingerprint: 'fp' },
      openedContent: {
        template: { v: 1, prompt: 'Continue @Nightly%20review', mentions: [sessionMention] },
        triggerEvidence: null,
      },
      runId: 'run-1',
    })).toEqual({ kind: 'contentInvalid' });
  });
});
