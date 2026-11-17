import type { DatabaseRelationV1 } from '@happier-dev/database-protocol';
import type { WorkbenchLocation } from '../models.js';

const MODES: readonly WorkbenchLocation['mode'][] = [
  'data',
  'structure',
  'console',
  'overview',
  'insights',
];

/** The page's shareable place: mode and relation. Filters, sort and paging stay page-local. */
export function encodeWorkbenchSubPath(
  location: Pick<WorkbenchLocation, 'mode' | 'relation'>,
): string {
  const relation = location.relation;
  const parts: string[] = [location.mode];
  // The host drops empty segments, so the optional database rides last instead of as a blank slot.
  if (relation) parts.push(relation.schema, relation.name, ...(relation.database ? [relation.database] : []));
  return parts.map(encodeURIComponent).join('/');
}

export function decodeWorkbenchSubPath(
  subPath: string | undefined,
): Pick<WorkbenchLocation, 'mode'> & { relation?: DatabaseRelationV1 } {
  const [mode, schema, name, database] = (subPath ?? '')
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => decodeURIComponent(part));
  const known = MODES.find((candidate) => candidate === mode) ?? 'overview';
  if (!name || !schema)
    return {
      mode: known === 'data' || known === 'structure' ? 'overview' : known,
    };
  return {
    mode: known,
    relation: { ...(database ? { database } : {}), schema, name },
  };
}
