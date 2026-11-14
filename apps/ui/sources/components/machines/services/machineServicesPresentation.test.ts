import { describe, expect, it } from 'vitest';

import {
  compareMachineServices,
  machineServiceControls,
  machineServiceDisplayName,
  machineServiceGroupKeys,
  machineServiceGroupOf,
  machineServiceHealthQualifier,
  machineServiceCanShowHealthWarning,
  machineServiceKind,
  machineServiceIdentityLine,
  machineServiceDeclaredFacts,
  machineServiceConfigurationRows,
  machineServiceWatchChoices,
  machineServiceRunFacts,
  machineServiceExpectedStop,
  machineDeploymentRoleSummary,
  machineServiceLogReadFailureReason,
} from './machineServicesPresentation';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

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
  it('presents unresolved names only from the producer marker and leaves native identity intact', () => {
    const nativeName = 'happier-' + 'a'.repeat(48);
    const unresolved = row(nativeName, { nameResolution: 'unresolved_environment', native: {
      phase: 'running', readiness: 'ready', displayName: nativeName } });
    expect(machineServiceDisplayName(unresolved)).toBe('Unresolved environment service');
    expect(machineServiceDisplayName(row(nativeName))).toBe(nativeName);
    expect(machineServiceDisplayName(row('Payments API'))).toBe('Payments API');
    expect(unresolved.name).toBe(nativeName);
    expect(machineServiceIdentityLine(unresolved)).toContain(nativeName);
  });

  it('keeps an inaccessible Environment service visible without health attention, preserving warnings for readable Environments and independent watches', () => {
    const service = row('web', { authority: 'project', lifecyclePurpose: 'deployment',
      environmentId: 'env-prod', state: 'unhealthy' });
    const headers = new Map<string, unknown>();
    expect(machineServiceCanShowHealthWarning(service, headers)).toBe(false);
    expect(service.state).toBe('unhealthy');
    headers.set('env-prod', { title: 'Production' });
    expect(machineServiceCanShowHealthWarning(service, headers)).toBe(true);
    headers.delete('env-prod');
    expect(machineServiceCanShowHealthWarning(service, headers)).toBe(false);
    expect(machineServiceCanShowHealthWarning(row('watched', { state: 'unhealthy' }), headers)).toBe(true);
    expect(machineServiceCanShowHealthWarning(row('dev', { authority: 'project', state: 'failed' }), headers)).toBe(true);
  });

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
    // The title already says the name; the identity line never repeats it ("Compose · web" under "web").
    const compose = { adapter: { pluginId: 'happier.machine.services', localId: 'compose' }, nativeResourceId: 'web' };
    expect(machineServiceIdentityLine(row('web', { nativeInstance: compose,
      native: { phase: 'running', readiness: 'ready', displayName: 'web' } }))).toBe('Compose');
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
  it('lists a service configuration as reported: where each port is published, each mount, and whether a health check exists', () => {
    const rows = machineServiceConfigurationRows({
      ports: [{ target: 8080, published: null, bindAddress: null, protocol: 'tcp' },
        { target: 5432, published: 15432, bindAddress: '127.0.0.1', protocol: 'tcp' }],
      mounts: [{ type: 'volume', source: 'uploads', target: '/app/uploads', readOnly: false },
        { type: 'bind', source: null, target: '/etc/app', readOnly: true }],
      healthcheck: 'configured',
    });
    const s = 'machineServices.configuration' as const;
    // Each entry is its value (a port, a mount) with what qualifies it beneath (lab dCtr): published or not, the mount's kind.
    expect(rows.map((row) => [row.key, row.entries])).toEqual([
      ['ports', [{ value: '8080/tcp', note: t(`${s}.notPublished`) },
        { value: '5432/tcp', note: t(`${s}.publishedOn`, { address: '127.0.0.1:15432' }) }]],
      ['mounts', [{ value: 'uploads → /app/uploads', note: 'volume' },
        { value: 'bind → /etc/app', note: t(`${s}.readOnly`) }]],
      ['healthCheck', [{ value: t(`${s}.healthConfigured`), note: null }]],
    ]);
    // Nothing declared says so; it never reads as an empty row.
    expect(machineServiceConfigurationRows({ ports: [], mounts: [], healthcheck: 'absent' }).map((row) => row.entries.map((entry) => entry.value)))
      .toEqual([[t(`${s}.none`)], [t(`${s}.none`)], [t(`${s}.healthAbsent`)]]);
  });
  it('adds what each container reports it runs: image and its ID, command, networks, health check and variable names', () => {
    const s = 'machineServices.configuration' as const;
    const detail = (nativeResourceId: string) => ({ nativeResourceId, image: 'ghcr.io/acme/billing-api:v1.42',
      imageDigest: 'sha256:4f1c2b3a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d9a2e', command: ['node', 'dist/server.js'],
      networks: ['billing_default'], networkMode: 'billing_default', variableNames: ['DATABASE_URL', 'LOG_LEVEL'],
      healthcheck: { test: ['CMD-SHELL', 'curl -f http://localhost:8080/healthz'], intervalNs: 10_000_000_000 } });
    // Two replicas of one service report the same configuration once.
    const rows = machineServiceConfigurationRows({ ports: [], mounts: [], healthcheck: 'configured' }, [detail('api-1'), detail('api-2')]);
    expect(rows.map((row) => [row.key, row.entries])).toEqual([
      ['image', [{ value: 'ghcr.io/acme/billing-api:v1.42', note: t(`${s}.imageId`, { id: 'sha256:4f1c2b3a9e8d' }) }]],
      ['command', [{ value: 'node dist/server.js', note: null }]],
      ['ports', [{ value: t(`${s}.none`), note: null }]],
      ['networks', [{ value: 'billing_default', note: null }]],
      ['mounts', [{ value: t(`${s}.none`), note: null }]],
      ['healthCheck', [{ value: 'curl -f http://localhost:8080/healthz',
        note: t(`${s}.healthEvery`, { interval: t('machineVitals.monitoring.seconds', { count: 10 }) }) }]],
      ['variables', [{ value: 'DATABASE_URL · LOG_LEVEL', note: t(`${s}.namesOnly`) }]],
    ]);
    // Host networking is said; an inherited interval (0) and a missing image ID are left out, never "every 0 s".
    const host = machineServiceConfigurationRows({ ports: [], mounts: [], healthcheck: 'configured' }, [{ ...detail('a'),
      imageDigest: null, command: null, networks: [], networkMode: 'host', variableNames: [],
      healthcheck: { test: ['CMD', 'pg_isready', '-q'], intervalNs: 0 } }]);
    expect(host.map((row) => [row.key, row.entries])).toEqual([
      ['image', [{ value: 'ghcr.io/acme/billing-api:v1.42', note: null }]],
      ['ports', [{ value: t(`${s}.none`), note: null }]],
      ['networks', [{ value: t(`${s}.networkMode`, { mode: 'host' }), note: null }]],
      ['mounts', [{ value: t(`${s}.none`), note: null }]],
      ['healthCheck', [{ value: 'pg_isready -q', note: null }]],
      ['variables', [{ value: t(`${s}.none`), note: null }]],
    ]);
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
  it('consumes the producer display label without deriving it from another row', () => {
    const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
    const nativeResourceId = JSON.stringify(['docker-engine', `happier-${'a'.repeat(64)}`]);
    const candidate = { candidateId: 'native-compose', revision: 'r1', name: 'Production database',
      adapter, nativeResourceId, observation: { phase: 'running' as const, readiness: 'not_reported' as const, endpoint: null } };
    const service = row('An older watch label', { nativeInstance: { adapter, nativeResourceId } });
    expect(machineServiceWatchChoices([candidate], [service])[0]).toMatchObject({
      candidateId: 'native-compose', name: 'Production database', watched: true,
    });
    // An unowned native project keeps the producer's name; a different identity must never borrow a service label.
    expect(machineServiceWatchChoices([candidate], [row('Other database', {
      nativeInstance: { adapter, nativeResourceId: JSON.stringify(['other-engine', `happier-${'a'.repeat(64)}`]) },
    })])[0]).toMatchObject({ name: candidate.name, watched: false });
    const unresolved = { ...candidate, name: `happier-${'b'.repeat(64)}`,
      nameResolution: 'unresolved_environment' as const };
    // Its only name is a generated hash and its identity a tuple: nothing a person could pick it by.
    expect(machineServiceWatchChoices([unresolved], [])).toEqual([]);
    expect(machineServiceWatchChoices([candidate], [])[0]).toMatchObject({ nativeResourceId, identityLine: null });
    expect(machineServiceWatchChoices([{ ...candidate, adapter: { ...candidate.adapter, localId: 'systemd' }, nativeResourceId: 'system/cron.service' }], [])[0])
      .toMatchObject({ identityLine: 'system/cron.service' });
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

describe('machineServiceLogReadFailureReason (DEPLOY-REACCEPT-1113 D4)', () => {
  it('states an unreachable Machine as the cause, by name', () => {
    for (const code of ['machine_offline', 'machine_unavailable', 'machine_socket_unavailable']) {
      expect(machineServiceLogReadFailureReason({ code }, 'build-box'))
        .toBe(t('machineServices.logs.error.machineNotAnswering', { machine: 'build-box' }));
    }
  });

  it('keeps a known cause from the shared failure owner', () => {
    const error = { code: 'machine_admin_access_required' };
    expect(machineServiceLogReadFailureReason(error, 'build-box'))
      .toBe(resolveActionExecutionErrorMessage(error, '', { safeToRetry: true }));
  });

  it('adds no body when the cause is unknown, so the title and Retry say it once', () => {
    expect(machineServiceLogReadFailureReason({ code: 'read_failed' }, 'build-box')).toBeUndefined();
    expect(machineServiceLogReadFailureReason(undefined, 'build-box')).toBeUndefined();
  });
});
