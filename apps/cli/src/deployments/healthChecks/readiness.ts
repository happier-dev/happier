import type { DeploymentDomainHeaderV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentHealthCurrentResultV1, ProjectReadinessFactOutcomeV1 } from '@happier-dev/protocol';
import type { SavedHealthCheckSourceRead } from './readSavedHealthCheckSource';

type ReadinessSource = Exclude<SavedHealthCheckSourceRead, { kind: 'available' }>
  | Pick<Extract<SavedHealthCheckSourceRead, { kind: 'available' }>, 'kind' | 'revision' | 'enabled' | 'source'>;

export type HealthCheckReadinessInput = Readonly<{
  source: ReadinessSource;
  observerMachineId: string | null;
  observerOnline: boolean | null;
  domains: readonly Pick<DeploymentDomainHeaderV1, 'id' | 'revision' | 'targetLinkId'>[];
  current?: DeploymentHealthCurrentResultV1;
}>;

/** The saved-check owner projects configured coverage; Project integrations only compose its outcome. */
export function readHealthCheckReadiness(input: HealthCheckReadinessInput): ProjectReadinessFactOutcomeV1 {
  const source = input.source;
  if (source.kind === 'unavailable') return { status: 'unavailable', reason: source.code };
  if (source.kind === 'unconfigured') return { status: 'actionNeeded', reason: 'health_checks_required' };
  const current = input.current?.ok ? input.current.domainHealth : undefined;
  const domains = input.domains.flatMap(domain => {
    const row = current?.find(row => row.domainId === domain.id && row.domainRevision === domain.revision);
    return row ? [{ domainId: row.domainId, domainRevision: row.domainRevision, facts: row.facts }] : [];
  });
  const outcome = (status: ProjectReadinessFactOutcomeV1['status'], reason: string): ProjectReadinessFactOutcomeV1 => ({
    status, reason, healthCoverage: { sourceRevision: source.revision, observerMachineId: input.observerMachineId,
      checkCount: source.source.checks.length, domains },
  });
  if (!source.enabled) return outcome('actionNeeded', 'health_checks_paused');
  if (!source.source.checks.length) return outcome('actionNeeded', 'health_checks_required');
  if (!input.observerMachineId) return outcome('actionNeeded', 'health_observer_required');
  if (input.observerOnline !== true) return outcome('unavailable', input.observerOnline === false
    ? 'health_observer_offline' : 'health_observer_presence_unavailable');
  if (input.domains.some(domain => !source.source.checks.some(check =>
    (check.binding.kind === 'environmentHealth' || check.binding.kind === 'domain')
      && check.binding.domainId === domain.id && check.binding.targetLinkId === domain.targetLinkId))) {
    return outcome('actionNeeded', 'health_domain_coverage_required');
  }
  if (input.domains.some(domain => !domains.some(row => row.domainId === domain.id && row.facts.availability === 'observed'))) {
    return outcome('unavailable', 'health_domain_observation_unavailable');
  }
  if (domains.some(row => row.facts.needsYou)) return outcome('actionNeeded', 'health_domain_needs_attention');
  return outcome('ready', 'health_checks_configured');
}

export type HealthAlertReadinessInput = Readonly<{
  source: ReadinessSource;
  controllerMachineId: string;
  controllerOnline: boolean | null;
  observerMachineId: string | null;
  observerOnline: boolean | null;
  /** Provider-owned inspection results in the saved channel order. */
  destinations: readonly (Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'unavailable'; reason: string }>)[];
}>;

/** Source/assignment/presence composition only; providers alone decide destination availability. */
export function readHealthAlertReadiness(input: HealthAlertReadinessInput): ProjectReadinessFactOutcomeV1 {
  const source = input.source;
  if (source.kind === 'unavailable') return { status: 'unavailable', reason: source.code };
  if (source.kind === 'unconfigured' || !source.source.alerts) return { status: 'actionNeeded', reason: 'health_alerts_required' };
  const alerts = source.source.alerts;
  const outcome = (status: ProjectReadinessFactOutcomeV1['status'], reason: string): ProjectReadinessFactOutcomeV1 => ({
    status, reason, alertWiring: { sourceRevision: source.revision, observerMachineId: input.observerMachineId,
      controllerMachineId: input.controllerMachineId, channelIds: alerts.channels.map(channel => channel.channelId), phases: alerts.phases },
  });
  if (!source.enabled) return outcome('actionNeeded', 'health_alerts_paused');
  if (!alerts.channels.length) return outcome('actionNeeded', 'health_alerts_off');
  if (!alerts.phases.includes('open') || !alerts.phases.includes('recovered')) {
    return outcome('actionNeeded', 'health_alert_phases_required');
  }
  if (!input.observerMachineId) return outcome('actionNeeded', 'health_observer_required');
  if (input.observerOnline !== true) return outcome('unavailable', input.observerOnline === false
    ? 'health_observer_offline' : 'health_observer_presence_unavailable');
  if (input.controllerOnline !== true) return outcome('unavailable', input.controllerOnline === false
    ? 'health_alert_controller_offline' : 'health_alert_controller_presence_unavailable');
  if (input.destinations.length !== alerts.channels.length) return outcome('unavailable', 'health_alert_destination_unavailable');
  const unavailable = input.destinations.find(destination => destination.kind === 'unavailable');
  if (unavailable?.kind === 'unavailable') return outcome('unavailable', unavailable.reason);
  return outcome('ready', 'health_alerts_configured');
}
