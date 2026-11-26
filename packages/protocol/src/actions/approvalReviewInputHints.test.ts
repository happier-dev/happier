import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { ApprovalReviewInputHintsSchema, InputHintsSchema } from '../inputs/inputFields.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { serializeActionSpec } from './actionCatalog.js';
import { ActionInputHintsSchema, ActionSpecSchema, getActionSpec } from './actionSpecs.js';

function createBaseSpec() {
  return {
    id: 'home.hub.layout.update' as const,
    title: 'Customize Home layout',
    safety: 'safe' as const,
    approval: { result: 'required' as const },
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: false,
      api: false,
      plugin: false,
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
  };
}

describe('approval review input hints overlap policy (Option D)', () => {
  it('accepts the real Home layout and Team credential update specs while keeping executable hints strict', () => {
    for (const actionId of ['home.hub.layout.update', 'teams.credentials.update'] as const) {
      const spec = getActionSpec(actionId);
      expect(ActionSpecSchema.safeParse(spec).error?.issues, actionId).toBeUndefined();
      if (spec.inputHints) {
        expect(ActionInputHintsSchema.safeParse(spec.inputHints).error?.issues, `${actionId}.inputHints`).toBeUndefined();
      }
      const serialized = serializeActionSpec(spec);
      if (serialized.inputHints) {
        expect(ActionInputHintsSchema.safeParse(serialized.inputHints).error?.issues, `${actionId}.serialized`).toBeUndefined();
      }
    }
  });

  it('permits strict descendants under a declared JSON parent only in approvalPresentation.inputHints', () => {
    const overlappingJsonHints = {
      fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json' as const, required: true },
        { path: 'intent.instanceIds', title: 'projects.dashboard.widgets', widget: 'json' as const },
      ],
    };
    const reversedOrderHints = {
      fields: [...overlappingJsonHints.fields].reverse(),
    };

    expect(ApprovalReviewInputHintsSchema.safeParse(overlappingJsonHints).success).toBe(true);
    expect(ApprovalReviewInputHintsSchema.safeParse(reversedOrderHints).success).toBe(true);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      approvalPresentation: { inputHints: overlappingJsonHints },
    }).error?.issues).toBeUndefined();

    // Executable hints and surface-binding hints remain strictly non-overlapping.
    expect(InputHintsSchema.safeParse(overlappingJsonHints).success).toBe(false);
    expect(ActionInputHintsSchema.safeParse(overlappingJsonHints).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      inputHints: overlappingJsonHints,
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      surfaceBindings: {
        agent: {
          inputSchema: z.strictObject({}),
          inputHints: overlappingJsonHints,
        },
      },
    }).success).toBe(false);
  });

  it('still rejects duplicate exact paths in approval review hints', () => {
    const duplicateParent = {
      fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json' as const },
        { path: 'intent', title: 'Duplicate intent', widget: 'json' as const },
      ],
    };
    const duplicateChild = {
      fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json' as const },
        { path: 'intent.instanceIds', title: 'Widgets', widget: 'json' as const },
        { path: 'intent.instanceIds', title: 'Widgets again', widget: 'json' as const },
      ],
    };

    expect(ApprovalReviewInputHintsSchema.safeParse(duplicateParent).success).toBe(false);
    expect(ApprovalReviewInputHintsSchema.safeParse(duplicateChild).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      approvalPresentation: { inputHints: duplicateParent },
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      approvalPresentation: { inputHints: duplicateChild },
    }).success).toBe(false);
  });

  it('still rejects descendants under non-JSON parents in approval review hints', () => {
    const directNonJsonParent = {
      fields: [
        { path: 'requestPolicy', title: 'Request policy', widget: 'text' as const },
        {
          path: 'requestPolicy.allowedProtocolKinds',
          title: 'Allowed protocols',
          widget: 'multiselect' as const,
          options: [{ value: 'openai_responses', label: 'OpenAI Responses' }],
        },
      ],
    };
    const nonJsonIntermediateParent = {
      fields: [
        { path: 'replacement', title: 'Changes', widget: 'json' as const },
        { path: 'replacement.requestPolicy', title: 'Request policy', widget: 'text' as const },
        {
          path: 'replacement.requestPolicy.allowedProtocolKinds',
          title: 'Allowed protocols',
          widget: 'multiselect' as const,
          options: [{ value: 'openai_responses', label: 'OpenAI Responses' }],
        },
      ],
    };

    expect(ApprovalReviewInputHintsSchema.safeParse(directNonJsonParent).success).toBe(false);
    expect(ApprovalReviewInputHintsSchema.safeParse(nonJsonIntermediateParent).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      approvalPresentation: { inputHints: directNonJsonParent },
    }).success).toBe(false);
    expect(ActionSpecSchema.safeParse({
      ...createBaseSpec(),
      approvalPresentation: { inputHints: nonJsonIntermediateParent },
    }).success).toBe(false);
  });

  it('keeps widget-property, secret-predicate, and strict-shape checks intact in approval review hints', () => {
    const missingSelectOptions = {
      fields: [
        { path: 'replacement', title: 'Changes', widget: 'json' as const },
        { path: 'replacement.sessionUsePolicy', title: 'Session use policy', widget: 'select' as const },
      ],
    };
    const invalidMultiselectSeparator = {
      fields: [
        { path: 'requestPolicy', title: 'Request policy', widget: 'json' as const },
        {
          path: 'requestPolicy.allowedProtocolKinds',
          title: 'Allowed protocols',
          widget: 'multiselect' as const,
          listSeparator: 'comma' as const,
          options: [{ value: 'openai_responses', label: 'OpenAI Responses' }],
        },
      ],
    };
    const invalidUnitOnText = {
      fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json' as const },
        { path: 'intent.label', title: 'Label', widget: 'text' as const, unit: 'bytes' as const },
      ],
    };
    const secretPredicateUnderJsonParent = {
      fields: [
        { path: 'replacement', title: 'Changes', widget: 'json' as const },
        { path: 'replacement.token', title: 'Token', widget: 'secret' as const },
        {
          path: 'replacement.note',
          title: 'Note',
          widget: 'text' as const,
          visibleWhen: { path: 'replacement.token', op: 'eq' as const, value: 'x' },
        },
      ],
    };
    const callerSuppliedPermissiveFlag = {
      allowJsonParentDescendants: true,
      fields: [
        { path: 'intent', title: 'Customization intent', widget: 'json' as const },
        { path: 'intent.instanceIds', title: 'Widgets', widget: 'json' as const },
      ],
    };

    for (const candidate of [
      missingSelectOptions,
      invalidMultiselectSeparator,
      invalidUnitOnText,
      secretPredicateUnderJsonParent,
      callerSuppliedPermissiveFlag,
    ]) {
      expect(ApprovalReviewInputHintsSchema.safeParse(candidate).success).toBe(false);
      expect(ActionSpecSchema.safeParse({
        ...createBaseSpec(),
        approvalPresentation: { inputHints: candidate },
      }).success).toBe(false);
    }
    expect(InputHintsSchema.safeParse(callerSuppliedPermissiveFlag).success).toBe(false);
  });

  it('retains localized child labels, selected-option labels, unhinted siblings, and a single reading per child across all three real overlapping groups', () => {
    // 1. home.hub.layout.update -> intent
    const homeSpec = getActionSpec('home.hub.layout.update');
    const homeArgs = homeSpec.inputSchema.parse({
      intent: {
        kind: 'group_create',
        groupId: 'group-1',
        title: 'Counts',
        instanceIds: ['widget-a', 'widget-b'],
      },
    });
    const homePresentation = describeApprovalActionFields({
      actionId: 'home.hub.layout.update',
      actionArgs: homeArgs,
    });
    expect(homePresentation.unrepresentable).toBeNull();
    expect(homePresentation.rows.filter((row) => row.path === 'intent')).toHaveLength(1);
    expect(homePresentation.rows.filter((row) => row.path === 'intent.instanceIds')).toHaveLength(0);
    const intentRow = homePresentation.rows.find((row) => row.path === 'intent');
    expect(intentRow).toMatchObject({ kind: 'value', title: 'Customization intent' });
    const intentEntries = intentRow?.kind === 'value' ? intentRow.entries ?? [] : [];
    expect(intentEntries.filter((entry) => entry.label === 'projects.dashboard.widgets')).toHaveLength(1);
    expect(intentEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'projects.dashboard.widgets', value: null }),
      expect.objectContaining({ value: 'widget-a', reference: { kind: 'homeLayoutItem', id: 'widget-a' } }),
      expect.objectContaining({ value: 'widget-b', reference: { kind: 'homeLayoutItem', id: 'widget-b' } }),
      expect.objectContaining({ label: 'Title', value: 'Counts' }),
    ]));

    // 2. teams.credentials.update -> requestPolicy
    const teamSpec = getActionSpec('teams.credentials.update');
    const requestPolicyArgs = teamSpec.inputSchema.parse({
      resourceId: 'resource-1',
      expectedRevision: 2,
      requestPolicy: {
        allowedProtocolKinds: ['openai_responses', 'anthropic_messages'],
        allowedModelIds: ['gpt-5'],
        reasoningEffort: null,
      },
    });
    const requestPolicyPresentation = describeApprovalActionFields({
      actionId: 'teams.credentials.update',
      actionArgs: requestPolicyArgs,
    });
    expect(requestPolicyPresentation.unrepresentable).toBeNull();
    expect(requestPolicyPresentation.rows.filter((row) => row.path === 'requestPolicy')).toHaveLength(1);
    expect(requestPolicyPresentation.rows.filter((row) => row.path === 'requestPolicy.allowedProtocolKinds')).toHaveLength(0);
    const requestPolicyRow = requestPolicyPresentation.rows.find((row) => row.path === 'requestPolicy');
    expect(requestPolicyRow).toMatchObject({ kind: 'value', title: 'Request policy' });
    const requestPolicyEntries = requestPolicyRow?.kind === 'value' ? requestPolicyRow.entries ?? [] : [];
    expect(requestPolicyEntries.filter((entry) => entry.label === 'Allowed protocols')).toHaveLength(1);
    expect(requestPolicyEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Allowed protocols',
        selectedOptions: [
          expect.objectContaining({
            value: 'openai_responses',
            label: 'OpenAI Responses',
            labelKey: 'teams.credentials.requestPolicy.protocol.openaiResponses',
          }),
          expect.objectContaining({
            value: 'anthropic_messages',
            label: 'Anthropic Messages',
            labelKey: 'teams.credentials.requestPolicy.protocol.anthropicMessages',
          }),
        ],
      }),
      expect.objectContaining({ label: 'Allowed model ids', value: null }),
      expect.objectContaining({ value: 'gpt-5' }),
      expect.objectContaining({ label: 'Reasoning effort', value: 'null', valueFormat: 'clear' }),
    ]));

    // 3. teams.credentials.update -> replacement
    const replacementArgs = teamSpec.inputSchema.parse({
      resourceId: 'resource-1',
      expectedRevision: 3,
      replacement: {
        sessionUsePolicy: 'team_context_required',
        requestPolicy: {
          allowedProtocolKinds: ['openai_responses'],
          allowedModelIds: ['gpt-5'],
          reasoningEffort: null,
        },
        usageLimitDelta: {
          upserts: [{
            subjectKind: 'each_member',
            subjectId: '',
            period: 'day',
            metric: 'total_tokens',
            maximum: '50000',
            enabled: true,
          }],
          deleteIds: [],
        },
      },
    });
    const replacementPresentation = describeApprovalActionFields({
      actionId: 'teams.credentials.update',
      actionArgs: replacementArgs,
    });
    expect(replacementPresentation.unrepresentable).toBeNull();
    expect(replacementPresentation.rows.filter((row) => row.path === 'replacement')).toHaveLength(1);
    for (const descendantPath of [
      'replacement.sessionUsePolicy',
      'replacement.requestPolicy.allowedProtocolKinds',
      'replacement.usageLimitDelta.upserts.[].subjectKind',
      'replacement.usageLimitDelta.upserts.[].period',
      'replacement.usageLimitDelta.upserts.[].metric',
    ]) {
      expect(replacementPresentation.rows.filter((row) => row.path === descendantPath), descendantPath).toHaveLength(0);
    }
    const replacementRow = replacementPresentation.rows.find((row) => row.path === 'replacement');
    expect(replacementRow).toMatchObject({ kind: 'value', title: 'Changes' });
    const replacementEntries = replacementRow?.kind === 'value' ? replacementRow.entries ?? [] : [];
    for (const childLabel of ['Session use policy', 'Allowed protocols', 'Audience', 'Period', 'Usage measure']) {
      expect(replacementEntries.filter((entry) => entry.label === childLabel), childLabel).toHaveLength(1);
    }
    expect(replacementEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Session use policy',
        selectedOptions: [expect.objectContaining({
          value: 'team_context_required',
          label: 'Team context required',
          labelKey: 'teams.credentials.usePolicy.teamContextRequired',
        })],
      }),
      expect.objectContaining({
        label: 'Allowed protocols',
        selectedOptions: [expect.objectContaining({
          value: 'openai_responses',
          label: 'OpenAI Responses',
          labelKey: 'teams.credentials.requestPolicy.protocol.openaiResponses',
        })],
      }),
      expect.objectContaining({
        label: 'Audience',
        selectedOptions: [expect.objectContaining({
          value: 'each_member',
          label: 'Each member',
          labelKey: 'teams.credentials.limits.subject.eachMember',
        })],
      }),
      expect.objectContaining({
        label: 'Period',
        selectedOptions: [expect.objectContaining({
          value: 'day',
          label: 'Day',
          labelKey: 'teams.credentials.limits.period.day',
        })],
      }),
      expect.objectContaining({
        label: 'Usage measure',
        selectedOptions: [expect.objectContaining({
          value: 'total_tokens',
          label: 'Tokens',
          labelKey: 'teams.credentials.limits.metric.tokens',
        })],
      }),
      // Unhinted siblings remain visible beside declared descendants.
      expect.objectContaining({ label: 'Allowed model ids', value: null }),
      expect.objectContaining({ value: 'gpt-5' }),
      expect.objectContaining({ label: 'Maximum', value: '50000' }),
    ]));
  });
});
