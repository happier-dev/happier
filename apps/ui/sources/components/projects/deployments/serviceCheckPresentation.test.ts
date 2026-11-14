import { describe, expect, it } from 'vitest';

import {
  readServiceCheckFacts,
  readServiceCheckSettings,
  serviceCheckInvestigationSubject,
  serviceCheckHistoryStrip,
} from './serviceCheckPresentation';

const DAY = 86_400_000;
const today = Date.UTC(2026, 10, 14);
const result = (status: 'up' | 'down' | 'degraded' | 'unknown') =>
  ({
    status,
    observedAt: today + 3_600_000,
    evidence: { kind: 'none' },
  }) as never;
const day = (
  offset: number,
  counts: Partial<Record<'up' | 'down' | 'degraded' | 'unknown', number>>,
  uptimePercent: number | null,
) => ({
  dayStartAt: today - offset * DAY,
  up: counts.up ?? 0,
  down: counts.down ?? 0,
  degraded: counts.degraded ?? 0,
  unknown: counts.unknown ?? 0,
  uptimePercent,
});

describe('Services → Checks (UPTIME-HISTORY-1113 history)', () => {
  it('reads the worst reported state and the lowest reported 30-day uptime, never computing one', () => {
    const facts = readServiceCheckFacts({
      kind: 'available',
      checks: [
        {
          checkId: 'a',
          result: result('up'),
          history: { lastObservedAt: today, uptimePercent: 99.9, days: [] },
        },
        {
          checkId: 'b',
          result: result('degraded'),
          history: { lastObservedAt: today, uptimePercent: 97.25, days: [] },
        },
        { checkId: 'c', result: result('up') },
      ],
    });
    expect(facts).toMatchObject({ status: 'degraded', uptimePercent: 97.25 });
  });

  it('keeps never-observed and unread states apart from a failing check', () => {
    expect(readServiceCheckFacts({ kind: 'neverObserved' }).status).toBe(
      'notChecked',
    );
    expect(readServiceCheckFacts({ kind: 'loading' }).status).toBe('loading');
    expect(
      readServiceCheckFacts({ kind: 'unavailable', code: 'x' }).status,
    ).toBe('unknown');
    expect(
      readServiceCheckFacts({ kind: 'available', checks: [] }).uptimePercent,
    ).toBeNull();
  });

  it('lays out today and the 29 days before it; a missing day is unobserved, never up', () => {
    const strip = serviceCheckHistoryStrip(
      {
        lastObservedAt: today,
        uptimePercent: 90,
        days: [
          day(0, { up: 10 }, 100),
          day(1, { up: 5, down: 1 }, 83.3),
          day(2, { up: 4, degraded: 2 }, 66.7),
        ],
      },
      today + 5_000,
    );
    expect(strip).toHaveLength(30);
    expect(strip.at(-1)).toMatchObject({
      dayStartAt: today,
      tone: 'up',
      uptimePercent: 100,
    });
    expect(strip.at(-2)).toMatchObject({ tone: 'down' });
    expect(strip.at(-3)).toMatchObject({ tone: 'degraded' });
    expect(strip.at(-4)).toMatchObject({
      tone: 'unobserved',
      uptimePercent: null,
    });
    expect(strip[0]!.dayStartAt).toBe(today - 29 * DAY);
  });
});

describe('A Check’s settings come from its saved source (the edit seed), as saved', () => {
  const seed = (sourceConfig: unknown, observation: unknown = {
    kind: 'socket', watcherMaterializationRef: { machineId: 'machine-observer', pluginId: 'p', materializationId: 'm' },
  }) => ({
    automationId: 'automation-a', triggerId: 'trigger-a', expectedTriggerRevision: 1, enabled: true,
    eventRef: { pluginId: 'happier.health', localId: 'changed' },
    source: { v: 1, sourceInstanceId: 'health:x', sourceContractVersion: 1, sourceConfig, displayLabel: 'n8n from outside' },
    observation, filter: null, maximumObservationAgeMs: null,
  }) as never;
  const check = (checkId: string, config: unknown, extra: Record<string, unknown> = {}) => ({
    checkId, kind: { pluginId: 'happier.machine.services', localId: 'http' }, binding: { kind: 'healthCheck' }, config,
    periodMs: 300_000, consecutiveFailuresBeforeAlerting: 2, ...extra,
  });
  const source = (checks: unknown[], alerts?: unknown) => ({
    v: 1, subject: { kind: 'machineService', machineId: 'machine-service', serviceId: 'n8n' }, checks,
    ...(alerts ? { alerts } : {}),
  });

  it('reads address, expectation, cadence, alerting and the observing Machine for the shown check', () => {
    const settings = readServiceCheckSettings(seed(source([
      check('first', { endpoint: 'https://first.example', expectStatus: 204 }),
      check('second', { endpoint: 'https://n8n.example', expectStatus: 200, keyword: 'n8n' }),
    ], { channels: [{ channelId: 'inbox' }, { channelId: 'slack' }], phases: ['open'] })), 'second');
    expect(settings).toEqual({
      kind: 'http',
      address: 'https://n8n.example',
      expectStatus: 200,
      keyword: 'n8n',
      periodMs: 300_000,
      failuresBeforeAlert: 2,
      alertChannels: 2,
      observerMachineId: 'machine-observer',
      subjectMachineId: 'machine-service',
      label: 'n8n from outside',
    });
  });

  it('says nothing it cannot read: an unparsable source or a missing seed yields no settings', () => {
    expect(readServiceCheckSettings(null, null)).toBeNull();
    expect(readServiceCheckSettings(seed({ v: 2 }), null)).toBeNull();
  });

  it('a TCP check has an address but no HTTP expectation; a webhook-delivered source has no observing Machine', () => {
    const settings = readServiceCheckSettings(seed(source([
      check('tcp', { host: 'db.internal', port: 5432 }, { kind: { pluginId: 'happier.machine.services', localId: 'tcp' } }),
    ]), { kind: 'durablePush', webhookEndpointId: 'w', webhookRoutingSourceInstanceId: 'health:x' }), null);
    expect(settings).toMatchObject({ kind: 'tcp', address: 'db.internal:5432', expectStatus: null, keyword: null,
      observerMachineId: null, alertChannels: 0 });
  });
});

describe('Investigate on a failing Check names the subject its saved source watches', () => {
  const seed = (sourceConfig: unknown) => ({
    automationId: 'automation-a', triggerId: 'trigger-a', expectedTriggerRevision: 1, enabled: true,
    eventRef: { pluginId: 'happier.machine.services', localId: 'changed' },
    source: { v: 1, sourceInstanceId: 'health:x', sourceContractVersion: 1, sourceConfig, displayLabel: 'Check' },
    observation: { kind: 'socket', watcherMaterializationRef: { machineId: 'm', pluginId: 'p', materializationId: 'x' } },
    filter: null, maximumObservationAgeMs: null,
  }) as never;
  const check = (checkId: string, binding: unknown) => ({
    checkId, kind: { pluginId: 'happier.machine.services', localId: 'http' }, binding, config: { keyword: 'ok' },
    periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1,
  });
  const environment = { kind: 'environment', environmentId: 'env-a' };

  it('a Domain-bound check investigates that Domain; another check on the Environment investigates the Environment', () => {
    const config = { v: 1, subject: environment, checks: [
      check('domain', { kind: 'domain', domainId: 'domain-a', targetLinkId: 'link-a', condition: 'domain_probe_failed' }),
      check('aggregate', { kind: 'environmentHealth', domainId: 'domain-b', targetLinkId: 'link-a' }),
    ] };
    expect(serviceCheckInvestigationSubject(seed(config), 'domain', 'server-a'))
      .toEqual({ kind: 'domain', serverId: 'server-a', environmentId: 'env-a', domainId: 'domain-a' });
    expect(serviceCheckInvestigationSubject(seed(config), 'aggregate', 'server-a'))
      .toEqual({ kind: 'deploymentEnvironment', serverId: 'server-a', environmentId: 'env-a' });
  });

  it('a Machine service check has no subject until the service identity is read; no source, no subject', () => {
    const config = { v: 1, subject: { kind: 'machineService', machineId: 'm', serviceId: 's' },
      checks: [check('svc', { kind: 'healthCheck' })] };
    expect(serviceCheckInvestigationSubject(seed(config), 'svc', 'server-a')).toBeNull();
    expect(serviceCheckInvestigationSubject(null, null, 'server-a')).toBeNull();
  });
});
