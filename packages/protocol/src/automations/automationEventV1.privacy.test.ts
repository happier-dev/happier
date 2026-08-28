import { describe, expect, it } from 'vitest';

import {
  AutomationEventActionHttpRequestSchemasV1,
  AutomationEventSourceCatalogStatusV1Schema,
  AutomationEventSourceStatusReportV1Schema,
  AutomationEventSourceStatusV1Schema,
} from './automationEventV1.js';
import { AutomationEventSourceCatalogStatusSchema } from './automationApiV3.js';

const sourceSelectorId = '9d5af559-2c82-4c22-b6a0-ecabce38a631';
const triggerId = 'trigger-1';
const triggerRevision = 3;
const immutableGenerationId = 'github-generation-1';
const materializationRef = {
  machineId: 'machine-1',
  materializationId: 'materialization-1',
  pluginId: 'com.acme.github',
} as const;

describe('Automation event V1 privacy projections', () => {
  it('rejects private trigger content from source and catalog status surfaces', () => {
    const sourceReport = {
      kind: 'source',
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      sourceSelectorId,
      state: 'observing',
      code: 'none',
      lastObservedAt: 10,
      lastDispositionAt: 11,
      nextRetryAt: null,
      observedDelta: 1,
      admittedDelta: 1,
      skippedDelta: 0,
    } as const;
    const sourceProjection = {
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: sourceReport.eventRef,
      sourceSelectorId,
      reporterMaterializationRef: materializationRef,
      reporterImmutableGenerationId: immutableGenerationId,
      state: 'observing',
      code: null,
      lastObservedAt: 10,
      lastDispositionAt: 11,
      nextRetryAt: null,
      observedCount: 1,
      admittedCount: 1,
      skippedCount: 0,
      revision: 1,
    } as const;
    const catalogProjection = {
      accountId: 'account-1',
      eventPluginId: 'com.acme.github',
      reporterMaterializationRef: materializationRef,
      reporterImmutableGenerationId: immutableGenerationId,
      scopeKey: 'checkpointedPull',
      observedRevision: '7',
      adoptedRevision: '7',
      state: 'current',
      scanStartedAt: 10,
      nextRetryAt: null,
      reportedAt: 11,
      revision: 1,
    } as const;

    expect(AutomationEventSourceStatusReportV1Schema.safeParse(sourceReport).success).toBe(true);
    expect(AutomationEventSourceStatusV1Schema.safeParse(sourceProjection).success).toBe(true);
    expect(AutomationEventSourceCatalogStatusV1Schema.safeParse(catalogProjection).success).toBe(true);
    const {
      reporterImmutableGenerationId: _catalogGeneration,
      ...catalogProjectionWithoutGeneration
    } = catalogProjection;
    expect(AutomationEventSourceCatalogStatusV1Schema.safeParse(
      catalogProjectionWithoutGeneration,
    ).success).toBe(false);

    for (const privateField of [
      { sourceInstanceId: 'repository-1' },
      { payload: { action: 'opened' } },
      { providerCursor: 'cursor-1' },
      { occurrenceEvidenceEqualityTag: 'server-private-tag' },
    ]) {
      expect(AutomationEventSourceStatusReportV1Schema.safeParse({
        ...sourceReport,
        ...privateField,
      }).success).toBe(false);
      expect(AutomationEventSourceStatusV1Schema.safeParse({
        ...sourceProjection,
        ...privateField,
      }).success).toBe(false);
      expect(AutomationEventSourceCatalogStatusV1Schema.safeParse({
        ...catalogProjection,
        ...privateField,
      }).success).toBe(false);
    }
  });

  it('does not accept a host-only equality tag from Event plugin admission', () => {
    const request = {
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        contributionLocalId: 'pull-request-opened',
        materialization: materializationRef,
        immutableGenerationId,
      },
      input: {
        eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{
          automationId: 'automation-1',
          triggerId,
          triggerRevision,
          sourceSelectorId,
        }],
      },
      hostEvidence: {
        v: 1,
        t: 'plain',
        accountCurrentness: {
          mode: 'plain',
          version: 1,
          contentKeyFingerprint: null,
        },
      },
    } as const;

    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.admit']
      .safeParse(request).success).toBe(true);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].safeParse({
      ...request,
      input: {
        ...request.input,
        occurrenceEvidenceEqualityTag: 'plugin-controlled-tag',
      },
    }).success).toBe(false);
  });

  it('does not expose catalog routing identity through the V3 definition projection', () => {
    const projection = {
      observedRevision: '7',
      adoptedRevision: '6',
      state: 'reconciling',
      scanStartedAt: 10,
      nextRetryAt: 11,
    } as const;

    expect(AutomationEventSourceCatalogStatusSchema.safeParse(projection).success).toBe(true);
    for (const privateField of [
      { accountId: 'account-1' },
      { eventPluginId: 'com.acme.github' },
      { reporterMaterializationRef: materializationRef },
      { reporterImmutableGenerationId: immutableGenerationId },
      { scopeKey: 'checkpointedPull' },
      { reportedAt: 12 },
      { revision: 1 },
      { providerCursor: 'cursor-1' },
      { payload: { action: 'opened' } },
    ]) {
      expect(AutomationEventSourceCatalogStatusSchema.safeParse({
        ...projection,
        ...privateField,
      }).success).toBe(false);
    }
  });
});
