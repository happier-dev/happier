import type { PluginServiceLaunchEnvironmentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { postgresqlCaptureUrl } from '@happier-dev/databases/postgresql';
import type { bindLocalCapture, CaptureUrlOffer } from './launch.js';
import type { CaptureProjectScope } from './configuration.js';
import { captureSourcePartition } from './partition.js';
import { LOCAL_CAPTURE_OTLP_PROTOCOL_ENVIRONMENT_NAMES } from '@happier-dev/database-protocol';

export { LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from '@happier-dev/database-protocol';
export type LocalCaptureScope = CaptureProjectScope;
export type LocalCaptureContributionOptions = Readonly<{
 environmentNames: readonly string[];
 readEnabled(scope: LocalCaptureScope): boolean | Promise<boolean>;
 acquireLocalCapture(input: Omit<Parameters<typeof bindLocalCapture>[0], 'runtime'> & Readonly<{ projectScope?: CaptureProjectScope }>): ReturnType<typeof bindLocalCapture>;
 signal?: AbortSignal;
}>;

/** B assigns sockets; A alone applies these selected transformations and defaults. */
export function createLocalCaptureContribution(options: LocalCaptureContributionOptions): PluginServiceLaunchEnvironmentRuntimeV1 {
 return { async prepare(input) {
  const unavailable = (reason: string) => ({ kind: 'unavailable' as const, code: 'service_launch_environment_unavailable' as const, reason });
  const scope = { serverId: input.project.serverId, machineId: input.workspace.machineId, projectId: input.project.projectId };
  if (!await options.readEnabled(scope)) return { kind: 'unchanged' };
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
  const controller = new AbortController();
  let lease: Awaited<ReturnType<typeof bindLocalCapture>>;
  try {
   lease = await options.acquireLocalCapture({ enabled: true,
    projectScope: scope,
    partition: captureSourcePartition({ kind: 'worktree', ...scope, workspaceId: input.workspace.id }),
    urls: selected.map(({ slot, offer }) => ({ ...offer, assignedPort: ports[slot]! })),
    ...(localOtlp ? { otlpPort: ports.otlp! } : {}), signal: options.signal ?? controller.signal });
  } catch (error) {
   controller.abort();
   return unavailable(error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed');
  }
  if (lease.failures.length) { await lease.release(); controller.abort(); return unavailable(lease.failures[0]!.code); }
  const defaults: Record<string, string> = {};
  if (localOtlp && lease.endpoint) {
   defaults.OTEL_EXPORTER_OTLP_ENDPOINT = lease.endpoint;
   if (environment.OTEL_EXPORTER_OTLP_PROTOCOL === undefined) defaults.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
   if (environment.OTEL_SERVICE_NAME === undefined) defaults.OTEL_SERVICE_NAME = `${scope.projectId}/${input.workspace.id}:${input.serviceId}`;
   if (environment.OTEL_RESOURCE_ATTRIBUTES === undefined) defaults.OTEL_RESOURCE_ATTRIBUTES = `happier.worktree.id=${input.workspace.id}`;
  }
  return { kind: 'replace', replacements: lease.replacements, defaults, async release() { controller.abort(); await lease.release(); } };
 } };
}
