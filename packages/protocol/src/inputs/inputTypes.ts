import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey,
  type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const HostInputTypeReferenceV1Schema = lazyZodSchema(() => z.union([
  z.object({ hostType: z.literal('usageQuery'), field: z.enum(['period', 'session']).optional() }).strict(),
  z.object({ hostType: z.enum(['session', 'workspace']) }).strict(),
]));
export type HostInputTypeReferenceV1 = z.infer<typeof HostInputTypeReferenceV1Schema>;
export const InputTypeReferenceV1Schema = lazyZodSchema(() => z.union([HostInputTypeReferenceV1Schema, asProtocolZod(PluginContributionIdentityV1Schema)]));
export type InputTypeReferenceV1 = z.infer<typeof InputTypeReferenceV1Schema>;

/** A type selects its declared Resource; it is never an executable callback id. */
export function inputTypeOptionsSourceId(type: InputTypeReferenceV1): string {
  if ('hostType' in type) return type.hostType === 'session' ? 'sessions' : `host-input:${type.hostType}${type.hostType === 'usageQuery' && type.field ? `:${type.field}` : ''}`;
  return `plugin-input:${buildQualifiedPluginContributionKey(type)}`;
}

export function parseInputTypeOptionsSourceId(value: string): InputTypeReferenceV1 | null {
  if (value === 'host-input:usageQuery') return { hostType: 'usageQuery' };
  if (value === 'host-input:usageQuery:period') return { hostType: 'usageQuery', field: 'period' };
  if (value === 'host-input:usageQuery:session') return { hostType: 'usageQuery', field: 'session' };
  if (value === 'host-input:workspace') return { hostType: 'workspace' };
  return value.startsWith('plugin-input:')
    ? parseQualifiedPluginContributionKey(value.slice('plugin-input:'.length)) : null;
}
