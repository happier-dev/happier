import { describe, expect, it } from 'vitest';
import { HealthCheckSourceConfigV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { DeploymentHealthCurrentSuccessV1Schema } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { readHealthCheckReadiness } from './readiness';

const source = { kind: 'available' as const, revision: 'source-revision', enabled: true,
  source: HealthCheckSourceConfigV1Schema.parse({ v: 1, subject: { kind: 'environment', environmentId: 'environment' }, checks: [
    { checkId: 'http', kind: { pluginId: 'happier.machine.services', localId: 'http' }, binding: { kind: 'healthCheck' },
      config: { endpoint: 'https://example.test/health', expectStatus: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 },
  ] }) };

describe('saved-check readiness owner', () => {
  it('recognizes a saved source and admitted observer without inventing outside proof', () => {
    expect(readHealthCheckReadiness({ source, observerMachineId: 'observer', observerOnline: true, domains: [] }))
      .toMatchObject({ status: 'ready', reason: 'health_checks_configured',
        healthCoverage: { sourceRevision: 'source-revision', observerMachineId: 'observer', checkCount: 1 } });
  });
  it('preserves unavailable saved-source admission', () => {
    expect(readHealthCheckReadiness({ source: { kind: 'unavailable', code: 'source_unavailable' },
      observerMachineId: 'observer', observerOnline: true, domains: [] }))
      .toMatchObject({ status: 'unavailable', reason: 'source_unavailable' });
  });
  it('distinguishes unconfigured, paused and offline checks from a source read failure', () => {
    const context = { observerMachineId: 'observer', observerOnline: true, domains: [] };
    expect(readHealthCheckReadiness({ ...context, source: { kind: 'unconfigured' } }))
      .toMatchObject({ status: 'actionNeeded', reason: 'health_checks_required' });
    expect(readHealthCheckReadiness({ ...context, source: { ...source, enabled: false } }))
      .toMatchObject({ status: 'actionNeeded', reason: 'health_checks_paused' });
    expect(readHealthCheckReadiness({ ...context, source, observerOnline: false }))
      .toMatchObject({ status: 'unavailable', reason: 'health_observer_offline' });
    expect(readHealthCheckReadiness({ ...context, source, observerOnline: null }))
      .toMatchObject({ status: 'unavailable', reason: 'health_observer_presence_unavailable' });
  });
  it('requires saved Domain coverage and retains the owner verdict, clock and same-Machine vantage', () => {
    const domain = { id: 'domain', targetLinkId: 'target', revision: 2 };
    const domainSource = { ...source, source: { ...source.source, checks: [{ ...source.source.checks[0]!,
      binding: { kind: 'environmentHealth' as const, domainId: domain.id, targetLinkId: domain.targetLinkId } }] } };
    const context = { observerMachineId: 'observer', observerOnline: true, domains: [domain] };
    expect(readHealthCheckReadiness({ ...context, source }))
      .toMatchObject({ status: 'actionNeeded', reason: 'health_domain_coverage_required' });
    expect(readHealthCheckReadiness({ ...context, source: domainSource }))
      .toMatchObject({ status: 'unavailable', reason: 'health_domain_observation_unavailable' });
    const current = DeploymentHealthCurrentSuccessV1Schema.parse({ ok: true, environmentId: 'environment',
      targetLinkId: 'target', observation: null, domainHealth: [{ domainId: 'domain', domainRevision: 2,
        observations: [], facts: { availability: 'observed', unavailableReason: null, observedAt: 123,
          vantage: 'sameMachine', certificate: { state: 'not_checked', expiresAt: null }, needsYou: null } }] });
    expect(readHealthCheckReadiness({ ...context, source: domainSource, current }))
      .toMatchObject({ status: 'ready', healthCoverage: { domains: [{ domainId: 'domain',
        facts: { observedAt: 123, vantage: 'sameMachine' } }] } });
    const failed = { ...current, domainHealth: current.domainHealth!.map(row => ({ ...row,
      facts: { ...row.facts, needsYou: { cause: 'http' as const, reason: 'http_failed', vantage: 'sameMachine' as const } } })) };
    expect(readHealthCheckReadiness({ ...context, source: domainSource, current: failed }))
      .toMatchObject({ status: 'actionNeeded', reason: 'health_domain_needs_attention' });
    expect(readHealthCheckReadiness({ ...context, source: domainSource, current: { ...current,
      domainHealth: current.domainHealth!.map(row => ({ ...row, domainRevision: row.domainRevision + 1 })) } }))
      .toMatchObject({ status: 'unavailable', reason: 'health_domain_observation_unavailable' });
  });
});
