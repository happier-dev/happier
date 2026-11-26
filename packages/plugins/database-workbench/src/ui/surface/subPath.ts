import { DatabaseTargetV1Schema, type DatabaseDescriptorV1, type DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { decodeBase64, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, encodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { normalizePluginUiSubPathV1 } from '@happier-dev/plugin-sdk/ui';
import type { WorkbenchLocation } from '../models.js';
import { workbenchTargetKey } from '../../targetIdentity.js';
import { databaseOriginName } from './engines.js';

export const WorkbenchModeSchema = defineProtocolUnion([
  defineProtocolLiteral('data'),
  defineProtocolLiteral('structure'),
  defineProtocolLiteral('console'),
  defineProtocolLiteral('overview'),
  defineProtocolLiteral('insights'),
]);

export type WorkbenchPlace = Pick<WorkbenchLocation, 'mode' | 'relation'>;

const displaySchema = defineProtocolObject({
  engine: defineProtocolString(),
  label: defineProtocolString(),
  origin: defineProtocolString(),
}, { policy: 'closed' });
const addressedTargetSchema = defineProtocolUnion([
  defineProtocolObject({ target: DatabaseTargetV1Schema, display: displaySchema }, { policy: 'closed' }),
  DatabaseTargetV1Schema,
]);
export type WorkbenchTargetDisplay = ReturnType<typeof displaySchema.parse>;

/** Mode and relation are shareable. Filters, sort and paging stay page-local. */
export function encodeWorkbenchSubPath(
  location: WorkbenchPlace | undefined,
  target?: DatabaseTargetV1,
  display?: WorkbenchTargetDisplay,
  prefix = '',
): string {
  const relation = location?.relation;
  const parts: string[] = location ? [location.mode] : [];
  // The host drops empty segments, so the optional database rides last instead of as a blank slot.
  if (relation) parts.push(relation.schema, relation.name, ...(relation.database ? [relation.database] : []));
  const place = parts.map(encodeURIComponent).join('/');
  if (!target) return prefix + place;
  const suffix = place ? `/${place}` : '';
  if (display) {
    const enriched = prefix + encodeWorkbenchRootSubPath(target, display) + suffix;
    // Keep the database reachable when its display text would exceed the host's route budget.
    if (normalizePluginUiSubPathV1(enriched) !== null) return enriched;
  }
  return prefix + encodeWorkbenchRootSubPath(target) + suffix;
}

/**
 * The database's root: its target with no place. Desktop shows it as the Overview beside the rail; a phone shows the
 * rail itself (lab tablesp), the page every place it opens goes back to.
 */
export function encodeWorkbenchRootSubPath(target: DatabaseTargetV1, display?: WorkbenchTargetDisplay): string {
  const targetKey = workbenchTargetKey(target);
  const selector = display ? JSON.stringify({ target: JSON.parse(targetKey), display }) : targetKey;
  return `target/${encodeBase64(new TextEncoder().encode(selector), 'base64url')}`;
}

/** Placement names the host installation. The selector carries only the target and display facts. */
export function encodeWorkbenchPageSubPath(
  { placement, target, engine, label, origin }: DatabaseDescriptorV1,
  /** Omitted: the database's root. */
  location?: WorkbenchPlace,
): string {
  const prefix = `~run-on/${placement.serverId}/${placement.machineId}/${placement.installationId}/`;
  // Managed read setup may refuse before the demand can return a descriptor.
  const display = target.kind === 'managed_deployment' ? { engine, label, origin: databaseOriginName(origin) } : undefined;
  return encodeWorkbenchSubPath(location, target, display, prefix);
}

export function decodeWorkbenchSubPath(
  subPath: string | undefined,
): { target?: DatabaseTargetV1; display?: WorkbenchTargetDisplay; place: WorkbenchPlace; root: boolean } {
  const parts = (subPath ?? '').replace(/^\/+/, '').split('/');
  try {
    let target: DatabaseTargetV1 | undefined;
    let display: WorkbenchTargetDisplay | undefined;
    if (parts[0] === 'target') {
      const selector = parts[1];
      if (!selector) return { place: { mode: 'overview' }, root: true };
      const decoded = JSON.parse(new TextDecoder().decode(decodeBase64(selector, 'base64url')));
      const addressed = addressedTargetSchema.parse(decoded);
      if ('display' in addressed) {
        target = addressed.target;
        display = addressed.display;
      } else {
        target = addressed;
      }
      parts.splice(0, 2);
    }
    const [mode, schema, name, database] = parts.map((part) => decodeURIComponent(part));
    const parsed = WorkbenchModeSchema.safeParse(mode);
    const known = parsed.success ? parsed.data : 'overview';
    const place: WorkbenchPlace = name && schema
      ? { mode: known, relation: { ...(database ? { database } : {}), schema, name } }
      : { mode: known === 'data' || known === 'structure' ? 'overview' : known };
    return { target, ...(display ? { display } : {}), place, root: !mode };
  } catch {
    return { place: { mode: 'overview' }, root: true };
  }
}
