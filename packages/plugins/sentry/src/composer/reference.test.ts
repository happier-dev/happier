import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import { deriveSentryCollisionScope } from '../instances/sentryCollisionScope.js';
import type { SentryEventProjectionV1 } from '../privacy/sentryEventProjection.js';
import {
  SENTRY_CONNECTED_ACCOUNT_ID,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_CONTRIBUTION_ID,
  SENTRY_ENTRY_KIND_ID,
  SENTRY_PLUGIN_ID,
  SENTRY_SCOPE_SEPARATOR,
} from '../sentryContracts.js';

import {
  createSentryEvidenceCandidate,
  deriveSentryEvidenceInstanceDigest,
  resolveSentryEvidenceReference,
} from './reference.js';
import { decodeSentryEvidenceCandidate } from './candidate.js';

const ORIGIN = 'https://de.sentry.io';
const ORGANIZATION_ID = '7701';
const ENTRY_ID = '1234';
const EVENT_ID = 'a'.repeat(32);

function configuredInstance(accountId = 'account-1') {
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: {
        service: { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONNECTED_ACCOUNT_ID },
        accountId,
      },
    },
    localInstanceKey: `${ORIGIN}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
    configuration: {
      v: 1 as const,
      token: encodeSentryInstanceConfiguration({
        v: 1,
        organizationId: ORGANIZATION_ID,
        projectScope: { kind: 'allAccessible' },
        environmentScope: { kind: 'all' },
      }),
    },
  };
}

function localRef() {
  return {
    kindId: SENTRY_ENTRY_KIND_ID,
    collisionScope: deriveSentryCollisionScope({
      deploymentOrigin: ORIGIN,
      organizationId: ORGANIZATION_ID,
    }),
    entryId: ENTRY_ID,
  };
}

function projectedEvent(eventId = EVENT_ID): SentryEventProjectionV1 {
  return {
    eventId,
    dateCreatedMs: Date.parse('2026-02-03T04:05:06.000Z'),
    title: 'ChargeDeclined: card was declined',
    message: 'card was declined',
    location: 'app/checkout.ts',
    culprit: 'submitOrder(app/checkout)',
    platform: 'javascript',
    sections: [{
      kind: 'exception',
      type: 'ChargeDeclined',
      value: 'card was declined',
      frames: [{
        filename: 'app/checkout.ts',
        function: 'submitOrder',
        lineNo: 42,
        colNo: 7,
        inApp: true,
        contextLine: 'await charge(card, total);',
        vars: {},
      }],
    }],
    tags: [],
    user: null,
    redactions: [{ path: 'contexts', reason: 'pluginWithheld' }],
    sensitivePaths: ['entries[0].data.values[0].value'],
    projectionTruncated: false,
    omitted: {
      sections: 0,
      frames: 0,
      breadcrumbs: 0,
      tags: 0,
      redactions: 0,
      sensitivePaths: 0,
    },
  };
}

function rawEvent(eventId = EVENT_ID) {
  return {
    eventID: eventId,
    dateCreated: '2026-02-03T04:05:06.000Z',
    title: 'ChargeDeclined: card was declined',
    message: 'card was declined',
    location: 'app/checkout.ts',
    culprit: 'submitOrder(app/checkout)',
    platform: 'javascript',
    entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'ChargeDeclined',
          value: 'card was declined',
          stacktrace: {
            frames: [{
              filename: 'app/checkout.ts',
              function: 'submitOrder',
              lineNo: 42,
              colNo: 7,
              inApp: true,
              context: [[42, 'await charge(card, total);']],
              vars: { card: 'must-not-survive' },
            }],
          },
        }],
      },
    }],
    contexts: { device: { name: 'must-not-survive' } },
  };
}

function host(
  response: Readonly<{ status: number; body: unknown }>,
  currentInstance = configuredInstance(),
) {
  const request = vi.fn(async (input: Readonly<{ url: string }>) => ({
    status: response.status,
    finalUrl: input.url,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(response.body)),
  }));
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Bearer secret' },
  }));
  const executeAction = vi.fn(async () => ({
    kind: 'read' as const,
    instances: [{ v: 1 as const, lifecycle: 'active' as const, configured: currentInstance }],
    status: 'complete' as const,
  }));
  return {
    request,
    materializeListedAccount,
    executeAction,
    context: {
      signal: new AbortController().signal,
      services: {
        actions: { execute: executeAction },
        connectedAccounts: { materializeListedAccount },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
  };
}

function disclosedCandidate(accountId = 'account-1') {
  const candidate = createSentryEvidenceCandidate({
    instance: configuredInstance(accountId),
    localRef: localRef(),
    selected: projectedEvent(),
  });
  if (candidate === null) throw new Error('fixture candidate must encode');
  return candidate;
}

describe('the Sentry selected-evidence Composer reference', () => {
  it('encodes only frozen identity and refuses over-bound candidates', () => {
    const candidate = disclosedCandidate();
    expect(decodeSentryEvidenceCandidate(candidate.candidate.id)).toEqual({
      sourceInstanceId: configuredInstance().instance.sourceInstanceId,
      instanceDigest: deriveSentryEvidenceInstanceDigest(configuredInstance()),
      entryId: ENTRY_ID,
      eventId: EVENT_ID,
    });
    expect(candidate.candidate.id).not.toContain('card was declined');
    expect(candidate.candidate.id).not.toContain(ORIGIN);
    expect(candidate.candidate.id).not.toContain('account-1');
    expect(createSentryEvidenceCandidate({
      instance: configuredInstance(),
      localRef: localRef(),
      selected: projectedEvent('x'.repeat(300)),
    })).toBeNull();
  });

  it('re-reads the exact occurrence through the canonical Action and publishes projected evidence', async () => {
    const candidate = disclosedCandidate();
    const harness = host({ status: 200, body: rawEvent() });

    const resolved = await resolveSentryEvidenceReference(candidate.candidate.id, harness.context);

    expect(resolved).toMatchObject({ id: candidate.candidate.id });
    expect(resolved.context).toContain('ChargeDeclined');
    expect(resolved.context).toContain('submitOrder');
    expect(resolved.context).not.toContain('must-not-survive');
    expect(harness.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${ORIGIN}/api/0/organizations/${ORGANIZATION_ID}/issues/${ENTRY_ID}/events/${EVENT_ID}/`,
      }),
      expect.anything(),
    );
    expect(harness.materializeListedAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        account: configuredInstance().binding.account,
      }),
      expect.anything(),
    );
    expect(harness.executeAction).toHaveBeenCalledWith(
      { pluginId: 'happier.triage', localId: 'sources/read-configured-v1' },
      { v: 1 },
      expect.objectContaining({ signal: harness.context.signal }),
    );
  });

  it('refuses a candidate after its configured source changes and performs no provider read', async () => {
    const candidate = disclosedCandidate();
    const changed = configuredInstance();
    const harness = host({ status: 200, body: rawEvent() }, {
      ...changed,
      configuration: {
        ...changed.configuration,
        token: encodeSentryInstanceConfiguration({
          v: 1,
          organizationId: '7702',
          projectScope: { kind: 'allAccessible' },
          environmentScope: { kind: 'all' },
        }),
      },
    });

    await expect(resolveSentryEvidenceReference(candidate.candidate.id, harness.context))
      .rejects.toMatchObject({ code: 'sentry/evidence-unavailable' });
    expect(harness.materializeListedAccount).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('does not create a second frame or byte projection below the event projector', async () => {
    const candidate = disclosedCandidate();
    const frames = Array.from({ length: 9 }, (_, index) => ({
      filename: `app/frame-${String(index + 1)}.ts`,
      function: `projectedFrame${String(index + 1)}`,
      lineNo: index + 1,
      colNo: 1,
      inApp: true,
      context: [[index + 1, 'context']],
      vars: {},
    }));
    const event = { ...rawEvent(), entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'ChargeDeclined',
          value: 'all projected frames remain selected evidence',
          stacktrace: { frames },
        }],
      },
    }] };

    const resolved = await resolveSentryEvidenceReference(
      candidate.candidate.id,
      host({ status: 200, body: event }).context,
    );

    expect(resolved.context).toContain('projectedFrame9');
  });

  it('refuses invalid candidates and changed or unavailable events', async () => {
    const invalidHost = host({ status: 200, body: rawEvent() });
    await expect(resolveSentryEvidenceReference('not-a-candidate', invalidHost.context))
      .rejects.toMatchObject({ code: 'sentry/evidence-unavailable' });
    expect(invalidHost.request).not.toHaveBeenCalled();

    const candidate = disclosedCandidate();
    await expect(resolveSentryEvidenceReference(
      candidate.candidate.id,
      host({ status: 200, body: rawEvent('b'.repeat(32)) }).context,
    )).rejects.toMatchObject({ code: 'sentry/evidence-unavailable' });
    await expect(resolveSentryEvidenceReference(
      candidate.candidate.id,
      host({ status: 403, body: { detail: 'forbidden' } }).context,
    )).rejects.toMatchObject({ code: 'sentry/evidence-unavailable' });
  });
});
