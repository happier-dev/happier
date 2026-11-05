import { describe, expect, it } from 'vitest';

import {
  compareMachineServices,
  machineServiceControls,
  machineServiceGroupKeys,
  machineServiceGroupOf,
  machineServiceHealthQualifier,
  machineServiceKind,
  machineServiceIdentityLine,
  machineServiceDeclaredFacts,
  machineServiceWatchChoices,
  machineServiceRunFacts,
  machineServiceExpectedStop,
  machineDeploymentRoleSummary,
} from './machineServicesPresentation';

type Row = Parameters<typeof compareMachineServices>[0];
function row(name: string, patch: Partial<Row> = {}): Row {
  return {
    serviceId: name,
    name,
    authority: 'machine',
    lifecyclePurpose: 'development',
    generation: 'g1',
    state: 'running',
    capabilities: {
      start: true,
      stop: true,
      restart: true,
      logs: true,
      accounting: false,
    },
    watchId: `w-${name}`,
    watchRevision: 'r1',
    ...patch,
  };
}
const SYSTEMD = { pluginId: 'happier.machine.services', localId: 'systemd' };
describe('Machine services presentation', () => {
  it('groups deployed services by their real Environment, never a Workspace service or an independent watch', () => {
    const web = row('web', { authority: 'project', lifecyclePurpose: 'deployment', environmentId: 'env-prod' });
    const staging = row('web-staging', { authority: 'project', lifecyclePurpose: 'deployment', environmentId: 'env-staging' });
    const devServer = row('vite', { authority: 'project', lifecyclePurpose: 'development' });
    const caddy = row('caddy', { lifecyclePurpose: 'infrastructure' });
    const adopted = row('postgresql', { lifecyclePurpose: 'deployment' });
    const sandbox = row('sandbox-proxy', { authority: 'plugin', lifecyclePurpose: 'infrastructure' });
    expect(machineServiceGroupOf(web)).toBe('environment:env-prod');
    expect(machineServiceGroupOf(staging)).toBe('environment:env-staging');
    expect(machineServiceGroupOf(devServer)).toBe('development');
    expect(machineServiceGroupOf(caddy)).toBe('infrastructure');
    expect(machineServiceGroupOf(adopted)).toBe('watched');
    expect(machineServiceGroupOf(sandbox)).toBe('plugin');
    // Environments lead in a stable order that never moves when their names arrive; empty groups are not drawn.
    expect(machineServiceGroupKeys([caddy, staging, devServer, web, adopted])).toEqual([
      'environment:env-prod', 'environment:env-staging', 'infrastructure', 'watched', 'development',
    ]);
  });

  it('names what kind of service a row is only from facts its producer supplies', () => {
    expect(machineServiceKind(row('caddy', { nativeInstance: { adapter: SYSTEMD, nativeResourceId: 'caddy.service' } }))).toBe('systemd');
    expect(machineServiceKind(row('web', { authority: 'project', environmentId: 'env-prod' }))).toBe('compose');
    expect(machineServiceKind(row('vite', { authority: 'project' }))).toBeNull();
  });

  it('presents the plugin native name independently of the watch label and opaque identity', () => {
    const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'compose' },
      nativeResourceId: JSON.stringify(['engine-a', 'existing-production']) };
    const native = { phase: 'running' as const, readiness: 'ready' as const, displayName: 'Native project title' };
    const named = machineServiceIdentityLine(row('My production watch', { nativeInstance: instance, native }));
    expect(named).toContain('Native project title');
    expect(named).not.toContain('existing-production');
    expect(named).not.toContain('engine-a');
    expect(named).not.toContain('My production watch');
    const unnamed = machineServiceIdentityLine(row('My production watch', { nativeInstance: instance }));
    expect(unnamed).not.toContain(instance.nativeResourceId);
    expect(unnamed).not.toContain('existing-production');
  });

  it('offers only the controls the row says the service supports for its current generation', () => {
    expect(machineServiceControls(row('pg'))).toEqual({ restart: true, stop: true, start: false });
    expect(machineServiceControls(row('redis', { state: 'stopped' }))).toEqual({ restart: false, stop: false, start: true });
    expect(machineServiceControls(row('ts', { capabilities: { start: false, stop: false, restart: false, logs: true, accounting: false } })))
      .toEqual({ restart: false, stop: false, start: false });
    // An unanswered service has no generation to control.
    expect(machineServiceControls(row('gone', { generation: null, state: 'unknown' }))).toEqual({ restart: false, stop: false, start: false });
  });

  it('puts work that needs the person first and never orders an unanswered service with the stopped ones', () => {
    const sorted = [
      row('b', { state: 'stopped' }),
      row('a', { state: 'unknown' }),
      row('c', { state: 'failed' }),
      row('d'),
    ]
      .sort(compareMachineServices)
      .map((service) => service.name);
    expect(sorted).toEqual(['c', 'a', 'd', 'b']);
  });
  it('never lets a running service without a verified health result read as healthy', () => {
    const live = { health: { status: 'unknown' as const, observedAtMs: 1, freshness: 'current' as const } };
    // The first live native deployment (QA 2026-11-01): running, no health check reported.
    expect(machineServiceHealthQualifier(row('app', { ...live, native: { phase: 'running', readiness: 'not_reported' } })))
      .toBe('noCheck');
    expect(machineServiceHealthQualifier(row('app', { ...live, native: { phase: 'running', readiness: 'not_ready' } })))
      .toBe('notVerified');
    expect(machineServiceHealthQualifier(row('app', { health: { ...live.health, status: 'down' } }))).toBe('failing');
    expect(machineServiceHealthQualifier(row('app', { health: { ...live.health, status: 'degraded' } }))).toBe('degraded');
    expect(machineServiceHealthQualifier(row('app', { health: { ...live.health, status: 'up' } }))).toBeNull();
    // Producers that report no health facts (a watched unit) and states that already speak say nothing more.
    expect(machineServiceHealthQualifier(row('postgresql'))).toBeNull();
    expect(machineServiceHealthQualifier(row('app', { ...live, state: 'healthy' }))).toBeNull();
    expect(machineServiceHealthQualifier(row('app', { ...live, state: 'stopped' }))).toBeNull();
  });
  it('says what a declared configuration does, and nothing for the defaults', () => {
    const config = (patch: Partial<Parameters<typeof machineServiceDeclaredFacts>[0]>) => ({
      replicas: null, resources: { cpus: null, memory: null }, restartPolicy: null, ...patch,
    });
    // The live Compose service (QA 2026-11-02): one replica and `restart: "no"`, which reads "Never", not "1 declared · no".
    expect(machineServiceDeclaredFacts(config({ replicas: 1, restartPolicy: 'no' })))
      .toEqual({ replicas: null, restart: 'never', limits: null });
    expect(machineServiceDeclaredFacts(config({ replicas: 3, restartPolicy: 'on-failure:5' })))
      .toEqual({ replicas: 3, restart: 'onFailure', limits: null });
    expect(machineServiceDeclaredFacts(config({ restartPolicy: 'unless-stopped', resources: { cpus: 0.5, memory: '512m' } })))
      .toEqual({ replicas: null, restart: 'unlessStopped', limits: '0.5 CPU · 512m' });
    expect(machineServiceDeclaredFacts(config({ restartPolicy: 'always' })).restart).toBe('always');
    // A value Compose may add later is shown as declared rather than hidden.
    expect(machineServiceDeclaredFacts(config({ restartPolicy: 'sometimes' })).restart).toBe('sometimes');
  });
  it('offers each discovered service once, by kind then name, with what is already watched held back', () => {
    const adapter = (localId: string) => ({ pluginId: 'happier.machine.services', localId });
    const candidate = (name: string, localId: string, phase: 'running' | 'stopped' = 'running') => ({
      candidateId: `c-${name}`, revision: `r-${name}`, name, adapter: adapter(localId), nativeResourceId: `${name}.unit`,
      observation: { phase, readiness: 'not_reported' as const, endpoint: null },
    });
    const watched = row('redis', { nativeInstance: { adapter: adapter('docker'), nativeResourceId: 'redis.unit' } });
    const choices = machineServiceWatchChoices(
      [candidate('redis', 'docker'), candidate('fail2ban', 'systemd'), candidate('cron', 'systemd', 'stopped')], [watched]);
    expect(choices.map(choice => [choice.kind, choice.name, choice.watched])).toEqual([
      ['docker', 'redis', true], ['systemd', 'cron', false], ['systemd', 'fail2ban', false],
    ]);
    expect(choices[1]).toMatchObject({ candidateId: 'c-cron', revision: 'r-cron', nativeResourceId: 'cron.unit', phase: 'stopped' });
  });
  it('says how much memory a service uses and how long it has run only from what its source reported', () => {
    const now = 10 * 3_600_000;
    // MACH-SVC-DATA props: a real zero stays, an unknown counter is absent (never read as 0).
    expect(machineServiceRunFacts(row('web', { accounting: { memoryBytes: 98 * 1024 * 1024, startedAtMs: now - 4 * 3_600_000 } }), now))
      .toEqual({ memoryBytes: 98 * 1024 * 1024, upMs: 4 * 3_600_000 });
    expect(machineServiceRunFacts(row('app', { accounting: { memoryBytes: 0 } }), now)).toEqual({ memoryBytes: 0, upMs: null });
    expect(machineServiceRunFacts(row('app'), now)).toEqual({ memoryBytes: null, upMs: null });
    // A stopped service has not been up since its last start.
    expect(machineServiceRunFacts(row('cron', { state: 'stopped', accounting: { startedAtMs: 1 } }), now).upMs).toBeNull();
  });
  it('reads a service stopped on request as expected, quiet and without a failing health check', () => {
    const health = { status: 'down' as const, observedAtMs: 1, freshness: 'current' as const, expectedDown: 'stop' as const };
    expect(machineServiceExpectedStop(row('kuma', { state: 'stopped', health }))).toBe('stopped');
    // While it goes down its health source may already report unhealthy: still the stop the person asked for.
    expect(machineServiceExpectedStop(row('kuma', { state: 'unhealthy', health }))).toBe('stopping');
    expect(machineServiceExpectedStop(row('kuma', { state: 'stopping', health }))).toBe('stopping');
    expect(machineServiceHealthQualifier(row('kuma', { state: 'running', health }))).toBeNull();
    // Without the producer's expectation a stopped or failing service keeps its own state.
    expect(machineServiceExpectedStop(row('kuma', { state: 'stopped' }))).toBeNull();
    expect(machineServiceExpectedStop(row('kuma', { state: 'unhealthy', health: { ...health, expectedDown: undefined } }))).toBeNull();
    // A service that came back up is no longer "stopped on request".
    expect(machineServiceExpectedStop(row('kuma', { state: 'running', health }))).toBeNull();
  });
  it('names each Environment role once, in header order, never a service role', () => {
    const env = (environmentId: string, title: string, roles: readonly ('runtime' | 'data' | 'retiring' | 'detached' | 'controller' | 'build' | 'edge')[]) =>
      ({ environmentId, title, projectSourceId: 'src', roles });
    const environments = [env('prod', 'Production', ['runtime', 'controller']), env('docs', 'Docs', ['edge', 'build']),
      env('ci', 'CI', ['build']), env('shop', 'Shop', ['runtime', 'data'])];
    expect(machineDeploymentRoleSummary(environments).map(({ role, environments: serving }) =>
      ({ role, titles: serving.map(environment => environment.title) }))).toEqual([
      { role: 'controller', titles: ['Production'] }, { role: 'build', titles: ['Docs', 'CI'] }, { role: 'edge', titles: ['Docs'] }]);
  });
});
