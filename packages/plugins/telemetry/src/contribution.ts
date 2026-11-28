import { createCanonicalJsonSigningInput, type PluginServiceLaunchEnvironmentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
import type { DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { postgresqlCaptureUrl } from '@happier-dev/databases/postgresql';
import type { bindLocalCapture, CaptureUrlOffer } from './launch.js';
import type { CaptureProjectScope } from './configuration.js';
import type { LocalCaptureInput } from './background.js';
import { captureSourcePartition } from './partition.js';
import { LOCAL_CAPTURE_OTLP_PROTOCOL_ENVIRONMENT_NAMES } from '@happier-dev/database-protocol';

export { LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from '@happier-dev/database-protocol';
export type LocalCaptureScope = CaptureProjectScope;
export type LocalCaptureContributionOptions = Readonly<{
 environmentNames: readonly string[];
 readEnabled(scope: LocalCaptureScope): boolean | Promise<boolean>;
 acquireLocalCapture(input: LocalCaptureInput): ReturnType<typeof bindLocalCapture>;
 signal?: AbortSignal;
}>;

function captureUnavailableMessage(reason: string): string {
 switch (reason) {
  case 'EADDRINUSE': return "Capture isn't available: the listener port is already in use.";
  case 'EACCES': return "Capture isn't available: the listener port could not be opened.";
  case 'unsupported_execution_placement': return "Capture isn't available on this execution Machine.";
  case 'unsupported_otlp_transport': return "Capture isn't available with the configured OTLP protocol.";
  default: return "Capture isn't available: capture setup could not be completed.";
 }
}

/** B assigns sockets; A alone applies these selected transformations and defaults. */
export function createLocalCaptureContribution(options: LocalCaptureContributionOptions): PluginServiceLaunchEnvironmentRuntimeV1 {
 return { async prepare(input) {
  const unavailable = (reason: string) => ({
   kind: 'unavailable' as const, code: 'service_launch_environment_unavailable' as const, reason,
   diagnostic: { code: 'telemetry_capture_unavailable', message: captureUnavailableMessage(reason) },
  });
  const scope = { serverId: input.project.serverId, machineId: input.workspace.machineId, projectId: input.project.projectId };
  // Captures belong to the admitted launch requester; an unattributed launch records nothing.
  if (!input.requester || !await options.readEnabled(scope)) return { kind: 'unchanged' };
  const ownerAccountId = input.requester.accountId;
  if (input.executionPlacement.machineId !== input.workspace.machineId) return unavailable('unsupported_execution_placement');
  const { projectedEnvironment: environment } = await input.readEnvironment();
  const selected: { slot: string; offer: Omit<CaptureUrlOffer, 'assignedPort'> }[] = [];
  const keys = new Set<string>();
  for (const name of options.environmentNames) {
   const original = environment[name];
   if (original === undefined) continue;
   const parsed = postgresqlCaptureUrl(original);
   if (!parsed.eligible) return unavailable(parsed.reason);
   const slot = JSON.stringify(['postgresql', parsed.upstream.host, parsed.upstream.port]);
   keys.add(slot);
   selected.push({ slot, offer: { name, original, upstream: parsed.upstream, hostSpan: parsed.hostSpan } });
  }
  const localOtlp = environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
   && environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined && environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === undefined;
  if (localOtlp) for (const name of LOCAL_CAPTURE_OTLP_PROTOCOL_ENVIRONMENT_NAMES) {
   const protocol = environment[name];
   if (protocol !== undefined && protocol !== 'http/protobuf' && protocol !== 'http/json') return unavailable('unsupported_otlp_transport');
  }
  if (localOtlp) keys.add('otlp');
  if (!keys.size) return { kind: 'unchanged' };
  let ports = input.assignedPorts;
  if (input.requestListenerPorts) {
   const result = await input.requestListenerPorts([...keys]);
   if (result.kind !== 'ready') return unavailable(result.reason);
   ports = result.assignment.listenerPorts;
  }
  for (const key of keys) if (ports[key] === undefined) return unavailable('project_worktree_ports_unavailable');
  const members = selected.length ? await input.readWorktreeDatabaseMembers?.() : undefined;
  const worktreeSource = { kind: 'worktree', ...scope, workspaceId: input.workspace.id } as const satisfies DatabaseCaptureSourceV1;
  const admitFinding = input.admitWorktreeDatabaseAutomation;
  const databaseMembers = new Map(members?.map(member => [member.source.variable, member]));
  const urls = selected.map(({ slot, offer }) => ({ ...offer, assignedPort: ports[slot]!,
   databaseMember: databaseMembers.get(offer.name) }));
  const eligibleMembers = localOtlp && admitFinding ? (await Promise.all(urls.map(async ({ databaseMember }) => {
   if (!databaseMember || !await admitFinding(databaseMember).catch(() => false)) return [];
   return [[createCanonicalJsonSigningInput(databaseMember), projectAutomationDatabaseFindingSubjectV1(scope.serverId, databaseMember)] as const];
  }))).flat() : undefined;
  const controller = new AbortController();
  let lease: Awaited<ReturnType<typeof bindLocalCapture>>;
  try {
   lease = await options.acquireLocalCapture({ enabled: true,
    projectScope: scope, ownerAccountId, physicalRootIdentity: input.physicalRootIdentity,
    partition: captureSourcePartition(worktreeSource, ownerAccountId),
    ...(admitFinding && { worktreeSource }),
    ...(eligibleMembers?.length && { findingSubjects: new Map(eligibleMembers) }),
    urls,
    ...(localOtlp ? { otlpPort: ports.otlp! } : {}), signal: options.signal ?? controller.signal });
  } catch (error) {
   controller.abort();
   return unavailable(error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed');
  }
  const failedBinding = lease.failures[0];
  const warning = failedBinding && unavailable(failedBinding.code);
  if (warning && !lease.endpoint && Object.keys(lease.replacements).length === 0) {
   await lease.release();
   controller.abort();
   return warning;
  }
  const defaults: Record<string, string> = {};
  if (localOtlp && lease.endpoint) {
   defaults.OTEL_EXPORTER_OTLP_ENDPOINT = lease.endpoint;
   if (environment.OTEL_EXPORTER_OTLP_PROTOCOL === undefined) defaults.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
   if (environment.OTEL_SERVICE_NAME === undefined && input.serviceName) defaults.OTEL_SERVICE_NAME = input.serviceName;
   if (environment.OTEL_RESOURCE_ATTRIBUTES === undefined) defaults.OTEL_RESOURCE_ATTRIBUTES = `happier.worktree.id=${input.workspace.id}`;
  }
  return { kind: 'replace', replacements: lease.replacements, defaults, ...(warning ? { warning } : {}),
   async release() { controller.abort(); await lease.release(); } };
 } };
}
