import type { IconName } from '@/components/ui/icons/Icon';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import type { HealthCheckDomainSetupIntentV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { TriggerSubject } from './accountTriggerRows';
import { createDefaultWhen, readDeviceTimeZone, type TriggerWhenValue } from './sessionTriggerForm';
import { buildSimpleScheduleCron } from './triggerSchedule';

export type SubjectSentenceStarter = 'healthFailed' | 'deploymentFailed' | 'nightly';

const STARTER_EVENT: Readonly<Partial<Record<SubjectSentenceStarter | 'addCheck', PluginUiOpenAutomationEventRequestV1['eventRef']>>> = {
  addCheck: HEALTH_CHECK_EVENT_REFS_V1.status,
  healthFailed: HEALTH_CHECK_EVENT_REFS_V1.failed,
  deploymentFailed: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed,
};

/** The page supplies its subject; the existing contributed setup owns configuring the source. */
export function subjectStarterEventSeed(
  starter: SubjectSentenceStarter | 'addCheck' | null,
  params: Readonly<{
    subject?: TriggerSubject;
    serverId?: string;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    controllerMachineId?: string;
    domain?: HealthCheckDomainSetupIntentV1;
  }>,
): PluginUiOpenAutomationEventRequestV1 | undefined {
  const eventRef = starter ? STARTER_EVENT[starter] : undefined;
  if (!eventRef) return undefined;
  const observer = params.controllerMachineId ? { monitoringMachineId: params.controllerMachineId } : {};
  if (starter === 'deploymentFailed') {
    if (!params.deploymentEnvironment) return undefined;
    const { serverId, environmentId } = params.deploymentEnvironment;
    return { eventRef, ...observer, setupInput: { v: 1, serverId, environmentId } };
  }
  const subject = params.subject?.kind === 'environment'
    ? { kind: 'environment' as const, environmentId: params.subject.environmentId }
    : params.subject?.kind === 'service'
      ? { kind: 'machineService' as const, machineId: params.subject.machineId, serviceId: params.subject.serviceId }
      : null;
  if (!subject) return undefined;
  const nativeSourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
  if (starter === 'addCheck') {
    return { eventRef, ...observer, sourceInstanceId: nativeSourceInstanceId,
      setupInput: { v: 1, subject, ...(params.domain ? { domain: params.domain } : {}) } };
  }
  return params.serverId
    ? { eventRef, ...observer, setupInput: { v: 1, serverId: params.serverId, nativeSourceInstanceId } }
    : undefined;
}

/** Ordinary editor intent; source configuration and durable Save remain with their existing owners. */
export function subjectStarterWhen(starter: SubjectSentenceStarter | null): TriggerWhenValue {
  if (starter === 'nightly') {
    const schedule = { repeat: 'daily' as const, hour: 3, minute: 0, day: 1 };
    return { kind: 'schedule', schedule, expression: buildSimpleScheduleCron(schedule), timezone: readDeviceTimeZone() };
  }
  const eventRef = starter ? STARTER_EVENT[starter] : undefined;
  return eventRef ? { kind: 'pluginEvent', value: null, eventRef } : createDefaultWhen('schedule');
}

/**
 * A subject page's suggested entries: an ordinary sentence starter, or `addCheck`, which opens the trigger editor at
 * the service's own health form (a service can have several checks, so it is always offered).
 */
export type SubjectTriggerStarter = SubjectSentenceStarter | 'addCheck' | 'scheduledJob' | 'deployOnPush';

/**
 * The one starter table every subject page's Triggers section suggests when it is empty: what usually needs
 * watching on a Machine, an Environment or a service. Pages add a subject's starters here (MACH-COMPOSE-1107 §0.2,
 * shared by the Machine service page and the Environment page) instead of keeping their own list.
 */
export const SUBJECT_TRIGGER_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: ['healthFailed', 'nightly'],
  environment: ['deployOnPush', 'scheduledJob', 'deploymentFailed', 'healthFailed', 'nightly'],
  service: ['addCheck', 'healthFailed', 'nightly'],
};

/**
 * The starters that stay under a subject's triggers once it has some (O-MACH 11-07): a service keeps Add a check and
 * Investigate when health fails, because the section can't know which checks already exist (checks can be observed
 * from another Machine); the editor asks which health source to use.
 */
export const SUBJECT_TRIGGER_PERSISTENT_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: [],
  environment: ['deployOnPush', 'scheduledJob'],
  service: ['addCheck', 'healthFailed'],
};

export const SUBJECT_TRIGGER_STARTER_GLYPH: Readonly<Record<SubjectTriggerStarter, IconName>> = {
  addCheck: 'plus',
  scheduledJob: 'clock',
  deployOnPush: 'rocket-launch',
  healthFailed: 'pulse',
  deploymentFailed: 'rocket-launch',
  nightly: 'moon',
};
