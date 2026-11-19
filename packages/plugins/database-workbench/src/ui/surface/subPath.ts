import { DatabaseTargetV1Schema, type DatabaseDescriptorV1, type DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { decodeBase64, encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import type { WorkbenchLocation } from '../models.js';
import { workbenchTargetKey } from '../workbench.js';

const MODES: readonly WorkbenchLocation['mode'][] = [
  'data',
  'structure',
  'console',
  'overview',
  'insights',
];

export type WorkbenchPlace = Pick<WorkbenchLocation, 'mode' | 'relation'>;

/** Mode and relation are shareable. Filters, sort and paging stay page-local. */
export function encodeWorkbenchSubPath(
  location: WorkbenchPlace,
  target?: DatabaseTargetV1,
): string {
  const relation = location.relation;
  const parts: string[] = [location.mode];
  // The host drops empty segments, so the optional database rides last instead of as a blank slot.
  if (relation) parts.push(relation.schema, relation.name, ...(relation.database ? [relation.database] : []));
  const place = parts.map(encodeURIComponent).join('/');
  if (!target) return place;
  const selector = encodeBase64(new TextEncoder().encode(workbenchTargetKey(target)), 'base64url');
  return `target/${selector}/${place}`;
}

/** Placement names the host installation. Only the credential-free target enters the plugin path. */
export function encodeWorkbenchPageSubPath(
  { placement, target }: Pick<DatabaseDescriptorV1, 'placement' | 'target'>,
  location: WorkbenchPlace,
): string {
  return `~run-on/${placement.serverId}/${placement.machineId}/${placement.installationId}/${encodeWorkbenchSubPath(location, target)}`;
}

export function decodeWorkbenchSubPath(
  subPath: string | undefined,
): { target?: DatabaseTargetV1; place: WorkbenchPlace } {
  const parts = (subPath ?? '').replace(/^\/+/, '').split('/');
  try {
    let target: DatabaseTargetV1 | undefined;
    if (parts[0] === 'target') {
      const selector = parts[1];
      if (!selector) return { place: { mode: 'overview' } };
      const decoded = JSON.parse(new TextDecoder().decode(decodeBase64(selector, 'base64url')));
      target = DatabaseTargetV1Schema.parse(decoded);
      parts.splice(0, 2);
    }
    const [mode, schema, name, database] = parts.map((part) => decodeURIComponent(part));
    const known = MODES.find((candidate) => candidate === mode) ?? 'overview';
    const place: WorkbenchPlace = name && schema
      ? { mode: known, relation: { ...(database ? { database } : {}), schema, name } }
      : { mode: known === 'data' || known === 'structure' ? 'overview' : known };
    return { target, place };
  } catch {
    return { place: { mode: 'overview' } };
  }
}
