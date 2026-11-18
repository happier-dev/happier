import { describe, expect, it } from 'vitest';

import {
  readServiceCheckFacts,
  readServiceCheckRecent,
  readServiceCheckSettings,
  serviceCheckAutomationExecutionContext,
  serviceCheckShownDefinition,
  readServiceCheckDefinitions,
  serviceCheckResultWord,
  serviceCheckInvestigationSubject,
  serviceCheckSavedAutomationSubject,
  serviceCheckHistoryStrip,
  serviceCheckRecentBars,
  serviceCheckResponseSeries,
  serviceCheckAverageLatency,
  serviceCheckTodayUptime,
  serviceCheckMonitorSummary,
  serviceCheckStale,
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
      keyFlow: null,
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
    expect(serviceCheckAutomationExecutionContext(readServiceCheckSettings(seed(source([
      check('first', { endpoint: 'https://first.example', expectStatus: 204 }),
    ])), 'first'))).toEqual({ machineId: 'machine-observer', directory: '~' });
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
    expect(serviceCheckAutomationExecutionContext(settings)).toBeUndefined();
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

  it('a saved Check with no result yet has its Automations subject from its saved source; no source, no subject', () => {
    const config = { v: 1, subject: environment, checks: [
      check('first', { kind: 'environmentHealth', domainId: 'domain-b', targetLinkId: 'link-a' }),
      check('second', { kind: 'environmentHealth', domainId: 'domain-c', targetLinkId: 'link-a' }),
    ] };
    expect(serviceCheckSavedAutomationSubject(seed(config), null, 'server-a'))
      .toEqual({ kind: 'healthCheck', serverId: 'server-a', sourceInstanceId: 'health:x', checkId: 'first' });
    expect(serviceCheckSavedAutomationSubject(seed(config), 'second', 'server-a'))
      .toMatchObject({ checkId: 'second' });
    expect(serviceCheckSavedAutomationSubject(seed({ v: 2 }), null, 'server-a')).toBeNull();
    expect(serviceCheckSavedAutomationSubject(null, null, 'server-a')).toBeNull();
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
  it('retains an explicit gap between measured responses and keeps a measured zero', () => {
    const evidence = { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'Health check' },
      author: { kind: 'process' as const }, text: 'Observed response' }] };
    const recent = readServiceCheckRecent({ checkId: 'response-gap', result: {
      status: 'up', observedAt: today, latencyMs: 0, evidence,
    }, recentResults: [
      { status: 'up', observedAt: today - 3_000, latencyMs: 125, evidence },
      { status: 'unknown', observedAt: today - 2_000, evidence },
      { status: 'down', observedAt: today - 1_000, evidence },
      { status: 'up', observedAt: today, latencyMs: 0, evidence },
    ] });
    expect(serviceCheckResponseSeries(recent, 3_000)).toEqual([
      { observedAt: today - 3_000, latencyMs: 125 },
      { observedAt: today - 2_000, latencyMs: null },
      { observedAt: today - 1_000, latencyMs: null },
      { observedAt: today, latencyMs: 0 },
    ]);
  });

  it('draws the shown target’s response over the 24 hours before its newest result, oldest first (D36 2A/2B)', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const at = (hoursAgo: number, latencyMs?: number) =>
      ({ status: 'up', observedAt: today - hoursAgo * 3_600_000, ...(latencyMs === undefined ? {} : { latencyMs }), evidence: { kind: 'none' } }) as never;
    const facts = serviceCheckListFacts({
      native: { name: 'Shop' },
      definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: 'c1', name: 'HTTP', targetLabel: 'shop.example', periodMs: 60_000, domainId: null }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: at(0, 142),
        // Newest last, as the health owner retains them: one older than the window, one without a response time.
        recentResults: [at(30, 400), at(20, 150), at(6), at(2, 138), at(0, 142)], recentResultsCoverage: 'complete' }] },
    } as never);
    expect(facts.response24h).toEqual([
      { observedAt: today - 20 * 3_600_000, latencyMs: 150 },
      { observedAt: today - 6 * 3_600_000, latencyMs: null },
      { observedAt: today - 2 * 3_600_000, latencyMs: 138 },
      { observedAt: today, latencyMs: 142 },
    ]);
  });

  it('names a row by the target its definition checks, with its kind, cadence and latest result', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const facts = serviceCheckListFacts({
      native: { name: 'Workflow triggers' },
      definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: 'c1', name: 'HTTP check', targetLabel: 'shop.example/ready', periodMs: 300_000, domainId: null }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: { status: 'down', observedAt: today, latencyMs: 1200, evidence: { kind: 'none' } } as never }] },
    } as never);
    expect(facts.title).toBe('shop.example/ready');
    expect(facts.kind).toBe('HTTP check');
    expect(facts.every).toMatch(/5/);
    expect(facts.lastResult).toMatch(/1[.,]2/);
    expect(facts.lastTone).toBe('danger');
  });

  it('a row draws the failing check among its targets: its recent bars, response, cause, failing time and usual response', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const at = (minute: number, status: 'up' | 'degraded', latencyMs: number) =>
      ({ status, observedAt: today + minute * 60_000, latencyMs, evidence: { kind: 'none' } }) as never;
    const facts = serviceCheckListFacts({
      native: { name: 'Shop' },
      definitionFacts: { kind: 'available', observerMachineId: 'm1', checks: [{ checkId: 'ok', name: 'HTTP', targetLabel: 'shop.example', periodMs: 60_000, domainId: null }] },
      lastResults: { kind: 'available', checks: [
        { checkId: 'ok', result: at(3, 'up', 90), history: { lastObservedAt: today, uptimePercent: 100, days: [] } },
        { checkId: 'slow', result: at(3, 'degraded', 1800), recentResults: [at(1, 'up', 200), at(2, 'up', 200), at(3, 'degraded', 1800)],
          recentResultsCoverage: 'complete', failingSince: today + 3 * 60_000, failureStreak: 1,
          history: { lastObservedAt: today, uptimePercent: 97.2, days: [] } },
      ] },
    } as never, 4);
    expect(facts.status).toBe('degraded');
    expect(facts.recent.bars.map((bar) => bar.tone)).toEqual(['unobserved', 'up', 'up', 'degraded']);
    expect(facts.latencyMs).toBe(1800);
    expect(facts.usualMs).toBe(200);
    expect(facts.failingSince).toBe(today + 3 * 60_000);
    expect(facts.uptimePercent).toBe(97.2);
    expect(facts.observerMachineId).toBe('m1');
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

describe('a Check’s recent results as bars (MONITOR-LAB-1115 Q1)', () => {
  const at = (minute: number, status: 'up' | 'down' | 'degraded' | 'unknown', latencyMs?: number) =>
    ({ status, observedAt: today + minute * 60_000, evidence: { kind: 'none' }, ...(latencyMs === undefined ? {} : { latencyMs }) }) as never;
  const recentOf = (results: readonly unknown[], partial = false) =>
    readServiceCheckRecent({ checkId: 'a', result: results[results.length - 1] as never, recentResults: results as never,
      recentResultsCoverage: partial ? 'partial' : 'complete' } as never);

  it('draws the last results oldest first, one bar each, in the result’s own tone', () => {
    const bars = serviceCheckRecentBars(recentOf([at(1, 'up'), at(2, 'degraded'), at(3, 'down'), at(4, 'unknown')]), 3);
    expect(bars.bars.map((bar) => bar.tone)).toEqual(['degraded', 'down', 'unknownOnly']);
    expect(bars.partialLead).toBe(false);
  });

  it('a new check reserves its empty slots before the first results; nothing read yet is all empty slots', () => {
    expect(serviceCheckRecentBars(recentOf([at(1, 'up')]), 3).bars.map((bar) => bar.tone)).toEqual(['unobserved', 'unobserved', 'up']);
    expect(serviceCheckRecentBars(null, 2).bars.map((bar) => bar.tone)).toEqual(['unobserved', 'unobserved']);
  });

  it('leads with the partial mark only when trimmed results leave the bars short', () => {
    expect(serviceCheckRecentBars(recentOf([at(1, 'up'), at(2, 'up')], true), 3).partialLead).toBe(true);
    expect(serviceCheckRecentBars(recentOf([at(1, 'up'), at(2, 'up'), at(3, 'up')], true), 3).partialLead).toBe(false);
  });

  it('averages response over the last results that carry one and says how many it read', () => {
    const recent = recentOf([at(1, 'up', 400), at(2, 'up', 100), at(3, 'up'), at(4, 'up', 200)]);
    expect(serviceCheckAverageLatency(recent, 3)).toEqual({ averageMs: 150, count: 2 });
    expect(serviceCheckAverageLatency(recentOf([at(1, 'up')]), 60)).toBeNull();
  });

  it('reads today’s uptime from today’s UTC bucket only', () => {
    const history = { lastObservedAt: today, uptimePercent: 99, days: [day(0, { up: 9, down: 1 }, 90), day(1, { up: 1 }, 100)] };
    expect(serviceCheckTodayUptime(history as never, today + 3_600_000)).toBe(90);
    expect(serviceCheckTodayUptime({ ...history, days: [day(1, { up: 1 }, 100)] } as never, today + 3_600_000)).toBeNull();
  });
});

describe('Monitoring: what needs the person, and the counts that say it', () => {
  const row = (key: string, status: 'up' | 'down' | 'degraded' | 'unknown' | null, enabled = true, observerMachineId: string | null = null) => ({
    key, native: { enabled },
    definitionFacts: { kind: 'available', observerMachineId, checks: [] },
    lastResults: status === null ? { kind: 'neverObserved' } : { kind: 'available', checks: [{ checkId: key, result: result(status) }] },
  }) as never;

  it('counts down, slow and passing among running checks; a paused or unread check counts in none', () => {
    const summary = serviceCheckMonitorSummary([row('a', 'down'), row('b', 'degraded'), row('c', 'up'), row('d', 'up'),
      row('e', 'down', false), row('f', null), row('g', 'unknown')]);
    expect(summary).toMatchObject({ down: 1, degraded: 1, passing: 2 });
    expect([...summary.needsYou]).toEqual(['a', 'b']);
  });

  // MONITOR-ACCEPT-1116 F2: a check whose observing Machine is offline is not passing; its last answer is not today's.
  it('counts a check whose observer is offline as not checked, never as passing or needing the person', () => {
    const offline = new Set(['build-01']);
    const summary = serviceCheckMonitorSummary([row('a', 'up', true, 'build-01'), row('b', 'down', true, 'build-01'),
      row('c', 'up', true, 'web-01'), row('d', 'up', false, 'build-01')], offline);
    expect(summary).toMatchObject({ down: 0, degraded: 0, passing: 1, notChecked: 2 });
    expect([...summary.needsYou]).toEqual([]);
    expect(serviceCheckStale(row('a', 'up', true, 'build-01') as never, offline)).toBe(true);
    expect(serviceCheckStale(row('d', 'up', false, 'build-01') as never, offline)).toBe(false);
  });
});

// J5 / D33 (R2-B): a Key flow check's bars, uptime and recent results stay the persisted check results; its
// response trend is the collector's selected history, never the retained check timings.
describe('a Key flow check names its routes and reads its trend from the collector', () => {
  const keyFlow = {
    environmentId: 'env-prod', serviceName: 'billing-api',
    measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }, { method: 'GET', route: '/api/cart' }], statistic: 'p95' },
    windowMs: 600_000, threshold: { operator: 'above', value: 800 },
  };
  const source = {
    v: 1, subject: { kind: 'environment', environmentId: 'env-prod' },
    checks: [{ checkId: 'Checkout', kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, binding: { kind: 'healthCheck' },
      config: keyFlow, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 3 }],
  };

  it('names a named flow by its name, an unnamed one by its routes', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const listed = (config: object) => serviceCheckListFacts({
      native: { name: 'Event observation' },
      definitionFacts: { kind: 'available', observerMachineId: 'collector-b', checks: [{ checkId: 'Checkout', name: 'Key flow',
        targetLabel: 'POST /checkout, GET /api/cart', periodMs: 60_000, domainId: null, keyFlow: config }] },
      lastResults: { kind: 'neverObserved' },
    } as never);
    expect(listed({ ...keyFlow, name: 'Checkout' }).title).toBe('Checkout');
    expect(listed(keyFlow).title).toBe('POST /checkout, GET /api/cart');
  });

  it('states a latency to the precision a p95 is read at, the same way on every check', async () => {
    const { formatServiceCheckLatency } = await import('./serviceCheckPresentation');
    expect(formatServiceCheckLatency(1420)).toMatch(/^1\.42\b/);
    expect(formatServiceCheckLatency(388.4)).toMatch(/^388\b/);
    // A round second keeps its figures, so "1.40 sec" stands in a column beside "1.42 sec".
    expect(formatServiceCheckLatency(1400)).toMatch(/^1\.40\b/);
    expect(formatServiceCheckLatency(2000)).toMatch(/^2\.00\b/);
  });

  it('names a trend window’s two ends with their day, so a 24-hour window never reads as one day backwards', async () => {
    const { serviceCheckWindowEnds } = await import('./serviceCheckPresentation');
    const until = Date.UTC(2026, 10, 17, 12, 0);
    const [start, end] = serviceCheckWindowEnds(until - DAY, until, until);
    expect(start).not.toBe(end);
    expect(start).toMatch(/Mon/);
    expect(end).not.toMatch(/Mon|Tue/);
  });

  it('names the flow by its routes and keeps its saved selection', () => {
    const [definition] = readServiceCheckDefinitions({ sourceConfig: source, displayLabel: 'Checkout' })!;
    expect(definition).toMatchObject({ checkId: 'Checkout', targetLabel: 'POST /checkout, GET /api/cart', keyFlow });
  });

  it('a Key flow row draws no retained timing; it carries the collector, its saved flow and the newest result as the window end', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const at = (hoursAgo: number, latencyMs: number) =>
      ({ status: 'up', observedAt: today - hoursAgo * 3_600_000, latencyMs, evidence: { kind: 'none' } }) as never;
    const facts = serviceCheckListFacts({
      native: { name: 'Checkout' },
      definitionFacts: { kind: 'available', observerMachineId: 'collector-b', checks: [{ checkId: 'Checkout', name: 'Key flow',
        targetLabel: 'POST /checkout, GET /api/cart', periodMs: 60_000, domainId: null, keyFlow }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'Checkout', result: at(0, 412),
        recentResults: [at(2, 380), at(1, 395), at(0, 412)], recentResultsCoverage: 'complete' }] },
    } as never);
    expect(facts.response24h).toEqual([]);
    expect(facts.collectorTrend).toEqual({ collectorMachineId: 'collector-b', config: keyFlow, until: today });
  });

  it('says a failing or unknown Key flow in its measurement, never the producer’s reason code', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const row = (status: 'down' | 'unknown', value?: number) => ({
      native: { name: 'Checkout' },
      definitionFacts: { kind: 'available', observerMachineId: 'collector-b', checks: [{ checkId: 'Checkout', name: 'Key flow',
        targetLabel: 'POST /checkout', periodMs: 60_000, domainId: null, keyFlow }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'Checkout', result: { status, observedAt: today, evidence: { kind: 'none' },
        cause: { kind: 'keyFlow', vantage: 'sameMachine', reason: status === 'down' ? 'threshold_exceeded' : 'no_traffic' },
        measurements: { measure: 'p95', unit: 'ms', basis: 'metric_points', producers: [], window: { since: today - 600_000, until: today },
          completeness: value === undefined ? 'unknown' : 'complete', reasons: value === undefined ? ['no_traffic'] : [],
          ...(value === undefined ? {} : { value }) } } }] },
    }) as never;
    const failing = serviceCheckListFacts(row('down', 1420)).causeText;
    expect(failing).toMatch(/p95/);
    expect(failing).toMatch(/800/);
    expect(failing).not.toMatch(/threshold_exceeded/);
    const unknown = serviceCheckListFacts(row('unknown')).causeText;
    expect(unknown).toMatch(/10/);
    expect(unknown).not.toMatch(/no_traffic/);
  });

  it('every other check keeps its retained response and has no collector trend', async () => {
    const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
    const facts = serviceCheckListFacts({
      native: { name: 'Shop' },
      definitionFacts: { kind: 'available', observerMachineId: 'web-01', checks: [{ checkId: 'c1', name: 'HTTP',
        targetLabel: 'shop.example', periodMs: 60_000, domainId: null, keyFlow: null }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: { status: 'up', observedAt: today, latencyMs: 140,
        evidence: { kind: 'none' } } as never, recentResults: [{ status: 'up', observedAt: today - 60_000, latencyMs: 120, evidence: { kind: 'none' } },
        { status: 'up', observedAt: today, latencyMs: 140, evidence: { kind: 'none' } }] as never, recentResultsCoverage: 'complete' }] },
    } as never);
    expect(facts.collectorTrend).toBeNull();
    expect(facts.response24h).toHaveLength(2);
  });
});
