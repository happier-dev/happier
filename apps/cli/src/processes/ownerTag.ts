import type { ProcessOwnerRefV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createHash } from 'node:crypto';

import { configuration } from '@/configuration';
import { resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';

export const PROCESS_OWNER_ENV_KEY = 'HAPPIER_PROCESS_OWNER';

export type ProcessOwnerRef = Readonly<ProcessOwnerRefV1>;

export type ParsedProcessOwnerTag = Readonly<{
  daemonScopeKey: string;
  kind: ProcessOwnerRef['kind'];
  ownerId: string;
  owner: ProcessOwnerRef;
}>;

export function resolveProcessOwnerScopeKey(happierHomeDir: string, platform: NodeJS.Platform = process.platform): string {
  const comparable = resolveHappierHomeDirComparableKey(happierHomeDir, platform);
  if (!comparable) throw new Error('Process ownership requires a Happier home');
  return createHash('sha256').update(comparable).digest('hex').slice(0, 12);
}

export function processOwnerId(owner: ProcessOwnerRef): string {
  switch (owner.kind) {
    case 'session': return owner.sessionId;
    case 'terminal': return owner.terminalId;
    case 'service': return owner.serviceId;
    case 'container': return owner.containerId;
    case 'run': return owner.runId;
    case 'browser_sidecar': return 'browser_sidecar';
    case 'workspace_sync': return 'workspace_sync';
    case 'happier': return owner.component ?? 'daemon';
  }
}

export function formatProcessOwnerTag(input: Readonly<{
  happierHomeDir: string; owner: ProcessOwnerRef; platform?: NodeJS.Platform;
}>): string {
  if (input.owner.kind === 'container') throw new Error('Native container ownership cannot be established by an environment marker');
  const id = processOwnerId(input.owner);
  if (!id || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Invalid process owner id');
  return `v1.${resolveProcessOwnerScopeKey(input.happierHomeDir, input.platform)}.${input.owner.kind}.${id}`;
}

export function parseProcessOwnerTag(value: unknown): ParsedProcessOwnerTag | null {
  if (typeof value !== 'string') return null;
  const match = /^v1\.([0-9a-f]{12})\.([a-z_]+)\.(.+)$/.exec(value);
  if (!match) return null;
  const [, daemonScopeKey, kind, ownerId] = match;
  if (!ownerId || ownerId.trim() !== ownerId || /[\u0000-\u001f\u007f]/.test(ownerId)) return null;
  let owner: ProcessOwnerRef;
  switch (kind) {
    case 'session': owner = { kind, sessionId: ownerId }; break;
    case 'terminal': owner = { kind, terminalId: ownerId }; break;
    case 'service': owner = { kind, serviceId: ownerId }; break;
    case 'run': owner = { kind, runId: ownerId }; break;
    case 'browser_sidecar': if (ownerId !== kind) return null; owner = { kind }; break;
    case 'workspace_sync': if (ownerId !== kind) return null; owner = { kind }; break;
    case 'happier':
      if (ownerId === 'daemon') owner = { kind };
      else if (ownerId === 'voice_worker' || ownerId === 'device_helper' || ownerId === 'recording_encoder'
        || ownerId === 'plugin_database_worker' || ownerId === 'workspace_sync') owner = { kind, component: ownerId };
      else return null;
      break;
    default: return null;
  }
  return { daemonScopeKey: daemonScopeKey!, kind: owner.kind, ownerId, owner };
}

/** The host supplies this after native/provider/plugin environment composition. */
export function withProcessOwnerEnvironment<T extends string | undefined>(
  environment: Readonly<Record<string, T>>, owner: ProcessOwnerRef,
  happierHomeDir = configuration.happyHomeDir,
): Record<string, T | string> {
  return withHostProcessOwnerEnvironment(environment, formatProcessOwnerTag({ happierHomeDir, owner }));
}

/** Inherited host ownership is read independently of plugin-supplied launch env. */
export function readHostProcessOwnerTag(environment: NodeJS.ProcessEnv = process.env): string {
  const inherited = environment[PROCESS_OWNER_ENV_KEY];
  if (parseProcessOwnerTag(inherited)) return inherited!;
  return formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: { kind: 'happier' } });
}

export function withHostProcessOwnerEnvironment<T extends string | undefined>(
  environment: Readonly<Record<string, T>>, processOwnerTag = readHostProcessOwnerTag(),
): Record<string, T | string> {
  const result: Record<string, T | string> = { ...environment };
  for (const key of Object.keys(result)) if (key.toUpperCase() === PROCESS_OWNER_ENV_KEY) delete result[key];
  result[PROCESS_OWNER_ENV_KEY] = processOwnerTag;
  return result;
}
