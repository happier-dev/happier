import { describe, expect, it } from 'vitest';

import {
  readServiceCheckFacts,
  readServiceCheckRecent,
  readServiceCheckSettings,
  serviceCheckShownDefinition,
  readServiceCheckDefinitions,
  serviceCheckResultWord,
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
      run: {
        subject: { kind: 'machineService', machineId: 'machine-service', serviceId: 'n8n' },
        check: { checkId: 'second', kind: { pluginId: 'happier.machine.services', localId: 'http' } },
      },
    });
  });

  it('says nothing it cannot read: an unparsable source or a missing seed yields no settings', () => {
    expect(readServiceCheckSettings(null, null)).toBeNull();
    expect(readServiceCheckSettings(seed({ v: 2 }), null)).toBeNull();
  });

  it('reads a Domain check target from current Domain content, including its health route before any result exists', () => {
    const config = { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: [
      check('public', {}, { binding: { kind: 'domain', domainId: 'shop-domain', targetLinkId: 'runtime', condition: 'domain_probe_failed' } }),
    ] };
    const options = { domains: [{ domain: { id: 'shop-domain', environmentId: 'shop', targetLinkId: 'runtime' },
      content: { hostname: 'shop.example', target: { service: 'web', containerPort: 3000, path: '/store' },
        healthCheck: { path: '/ready', expectStatus: 204 } } }] };
    expect(readServiceCheckSettings(seed(config), 'public', options)).toMatchObject({ address: 'https://shop.example/ready', expectStatus: 204, periodMs: 300_000 });
  });

  it.each(['http', 'certificate'] as const)('uses the probe target builder for a Domain query route and exposes only its human route label (%s)', kind => {
    const name = kind === 'http' ? 'HTTP' : 'Certificate';
    const saved = { sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: [
      check('public', {}, { kind: { pluginId: 'happier.machine.services', localId: kind }, binding: { kind: 'domain', domainId: 'shop-domain', targetLinkId: 'runtime',
        condition: kind === 'http' ? 'domain_probe_failed' : 'certificate_renewal_failed' } }),
    ] }, displayLabel: 'Saved health checks' };
    const facts = readServiceCheckDefinitions(saved, { kindName: () => name, domains: [{
      domain: { id: 'shop-domain', environmentId: 'shop', targetLinkId: 'runtime' },
      content: { hostname: 'shop.example', target: { service: 'web', containerPort: 3000, path: '/store' },
        healthCheck: { path: '/ready?access_token=synthetic#ignored', expectStatus: 204 } },
    }] });
    expect(facts).toMatchObject([{ name, address: 'https://shop.example/ready?access_token=synthetic',
      targetLabel: 'shop.example/ready', periodMs: 300_000 }]);
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

describe('A Check’s retained results read newest first, with its failing streak only while it fails', () => {
  const sample = (status: 'up' | 'down', at: number, latencyMs?: number) =>
    ({ status, observedAt: at, ...(latencyMs === undefined ? {} : { latencyMs }), evidence: { v: 1, items: [] } }) as never;

  it('orders retained results newest first and keeps the owner’s failing-since and streak', () => {
    const recent = readServiceCheckRecent({
      checkId: 'a', result: sample('down', 300, 90),
      recentResults: [sample('up', 100, 80), sample('down', 200, 95), sample('down', 300, 90)],
      recentResultsCoverage: 'partial', failingSince: 200, failureStreak: 2,
    } as never);
    expect(recent.results.map((item) => item.observedAt)).toEqual([300, 200, 100]);
    expect(recent).toMatchObject({ partial: true, failingSince: 200, failureStreak: 2 });
  });

  it('a passing check has no failing facts; a check from before retention shows only its latest result', () => {
    const passing = readServiceCheckRecent({ checkId: 'a', result: sample('up', 300), failingSince: null, failureStreak: 0 } as never);
    expect(passing).toMatchObject({ failingSince: null, failureStreak: null, partial: false });
    expect(passing.results.map((item) => item.observedAt)).toEqual([300]);
  });
});

describe('a Check’s fact cells say a result, never repeat the unknown state the meta line already says', () => {
  it('names up, down and degraded results; unknown, not checked and loading leave the cell to its dash', () => {
    expect(serviceCheckResultWord('down')).toBeTruthy();
    expect(serviceCheckResultWord('up')).toBeTruthy();
    expect(serviceCheckResultWord('degraded')).toBeTruthy();
    expect(serviceCheckResultWord('unknown')).toBeNull();
    expect(serviceCheckResultWord('notChecked')).toBeNull();
    expect(serviceCheckResultWord('loading')).toBeNull();
  });
});

describe('the Check detail names what it checks from the inventory’s definition facts', () => {
  const facts = (checks: unknown[]) => ({ kind: 'available', checks }) as never;
  const definition = (checkId: string, targetLabel: string | null) => ({ checkId, name: 'HTTP', targetLabel, periodMs: 300_000, domainId: null });

  it('reads the shown check’s kind, target and cadence, else the first check', () => {
    const available = facts([definition('a', 'shop.example/ready'), definition('b', 'api.example/health')]);
    expect(serviceCheckShownDefinition(available, 'b')).toEqual({ kind: 'available', definition: definition('b', 'api.example/health') });
    expect(serviceCheckShownDefinition(available, 'missing')).toEqual({ kind: 'available', definition: definition('a', 'shop.example/ready') });
  });

  it('says loading or unavailable as the owner reports it; an empty definition list is unavailable', () => {
    expect(serviceCheckShownDefinition({ kind: 'loading' } as never, 'a')).toEqual({ kind: 'loading' });
    expect(serviceCheckShownDefinition({ kind: 'unavailable' } as never, 'a')).toEqual({ kind: 'unavailable' });
    expect(serviceCheckShownDefinition(facts([]), 'a')).toEqual({ kind: 'unavailable' });
  });
});

describe('Services → Checks rows (lab svcChk: named by what they check, Every, Last result)', () => {
  it('names a row by the target its definition checks, with its kind, cadence and latest result', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const facts = serviceCheckListFacts({
      native: { name: 'Workflow triggers' },
      definitionFacts: { kind: 'available', checks: [{ checkId: 'c1', name: 'HTTP check', targetLabel: 'shop.example/ready', periodMs: 300_000, domainId: null }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: { status: 'down', observedAt: today, latencyMs: 1200, evidence: { kind: 'none' } } as never }] },
    } as never);
    expect(facts.title).toBe('shop.example/ready');
    expect(facts.kind).toBe('HTTP check');
    expect(facts.every).toMatch(/5/);
    expect(facts.lastResult).toMatch(/1[.,]2/);
    expect(facts.lastTone).toBe('danger');
  });

  it('keeps the saved name and says nothing it cannot read while the definition is loading or unavailable', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    for (const kind of ['loading', 'unavailable'] as const) {
      const facts = serviceCheckListFacts({ native: { name: 'Workflow triggers' }, definitionFacts: { kind },
        lastResults: { kind: 'neverObserved' } } as never);
      expect(facts).toMatchObject({ title: 'Workflow triggers', kind: null, every: null, lastResult: null, lastTone: null });
    }
  });
});
