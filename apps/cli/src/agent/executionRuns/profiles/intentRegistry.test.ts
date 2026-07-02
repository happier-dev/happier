import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol';

import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
  resolveExecutionRunIntentProfile,
  resolveExecutionRunProfileContributionDescriptor,
} from './intentRegistry';
import * as intentRegistry from './intentRegistry';

describe('executionRun intent profile registry', () => {
  it('keeps profile coverage aligned with the protocol intent surface', () => {
    expect(listExecutionRunSupportedIntents().slice().sort()).toEqual(ExecutionRunIntentSchema.options.slice().sort());

    for (const intent of ExecutionRunIntentSchema.options) {
      expect(resolveExecutionRunIntentProfile(intent).intent).toBe(intent);
    }
  });

  it('does not expose the built-in profile map as an unmanaged registry bypass', () => {
    expect('EXECUTION_RUN_INTENT_PROFILE_REGISTRY' in intentRegistry).toBe(false);
  });

  it('keeps special start shaping isolated to profiles that need runtime evidence', () => {
    expect(typeof resolveExecutionRunIntentProfile('voice_agent').prepareStartParams).toBe('function');
    expect(typeof resolveExecutionRunIntentProfile('scm_commit_message').prepareStartParams).toBe('function');
    expect(typeof resolveExecutionRunIntentProfile('review').prepareStartParams).toBe('function');
    expect(resolveExecutionRunIntentProfile('plan').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('delegate').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('memory_hints').prepareStartParams).toBeUndefined();
  });

  it('builds an O(1) descriptor catalog keyed by profile id and intent', () => {
    const catalog = buildExecutionRunProfileCatalog([
      {
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        version: '1.0.0',
        intent: 'review',
        displayKey: 'plugins.acme.executionRuns.review.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        actionIds: [],
      },
    ]);

    expect(catalog.profileDescriptorsById).toBeInstanceOf(Map);
    expect(catalog.profileDescriptorIdsByIntent).toBeInstanceOf(Map);
    expect(resolveExecutionRunProfileContributionDescriptor(catalog, 'acme.review.profile')?.intent).toBe('review');
    expect(listExecutionRunProfileContributionDescriptors(catalog).map((entry) => entry.id)).toEqual([
      'acme.review.profile',
    ]);
    expect(catalog.profileDescriptorIdsByIntent.get('review')).toEqual(['acme.review.profile']);
  });

  it('rejects duplicate contributed profile ids before they can shadow canonical lookup', () => {
    expect(() => buildExecutionRunProfileCatalog([
      {
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        version: '1.0.0',
        intent: 'review',
        displayKey: 'plugins.acme.executionRuns.review.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        actionIds: [],
      },
      {
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        version: '1.0.0',
        intent: 'plan',
        displayKey: 'plugins.acme.executionRuns.plan.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        actionIds: [],
      },
    ])).toThrow(/Duplicate execution-run profile contribution/);
  });
});
