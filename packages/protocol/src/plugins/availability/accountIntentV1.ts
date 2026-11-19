import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginCollectionContractRefV1Schema, pluginCollectionContractKeyV1 } from '../data/collectionContractRefV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginReleaseVersionV1Schema } from './releaseRefV1.js';

export const PluginProjectScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('only'),
  projectKeys: z.array(z.string().check(z.trim(), z.minLength(1))),
}));
export type PluginProjectScopeV1 = z.infer<typeof PluginProjectScopeV1Schema>;

export function normalizePluginProjectScopeV1(scope: PluginProjectScopeV1): PluginProjectScopeV1 {
  return { kind: scope.kind, projectKeys: [...new Set(scope.projectKeys)].sort() };
}

export type PluginProjectAdmissionRefusalV1 = 'plugin_limited_to_other_projects';

export function resolvePluginProjectScopeRefusalV1(
  scope: PluginProjectScopeV1 | undefined,
  acceptedProjectKey: string | null,
): PluginProjectAdmissionRefusalV1 | null {
  return scope && (acceptedProjectKey === null || !scope.projectKeys.includes(acceptedProjectKey))
    ? 'plugin_limited_to_other_projects' : null;
}

/** Apply the captured Account restrictions once to the accepted Project at Session launch. */
export async function resolveSessionPluginProjectAdmissionV1(input: Readonly<{
  scopesByPluginId: readonly (readonly [pluginId: string, scope: PluginProjectScopeV1])[];
  readAcceptedProjectKey(): Promise<string | null>;
}>): Promise<ReadonlyMap<string, PluginProjectAdmissionRefusalV1>> {
  const refusals = new Map<string, PluginProjectAdmissionRefusalV1>();
  if (input.scopesByPluginId.length === 0) return refusals;
  const projectKey = await input.readAcceptedProjectKey();
  for (const [pluginId, scope] of input.scopesByPluginId) {
    const refusal = resolvePluginProjectScopeRefusalV1(scope, projectKey);
    if (refusal) refusals.set(pluginId, refusal);
  }
  return refusals;
}

/** Account intent is data-only; Action schemas must not load declaration projection. */
export const PluginAccountPluginIntentV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  desiredVersion: z.nullable(PluginReleaseVersionV1Schema),
  enabled: z.boolean(),
  projectScope: z.optional(PluginProjectScopeV1Schema),
  offlineUiHosting: z.enum(['disabled', 'enabled']),
  writableCollections: z.array(PluginCollectionContractRefV1Schema),
  revision: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
}).check(z.superRefine((value, context) => {
  const keys = new Set<string>();
  value.writableCollections.forEach((contract, index) => {
    if (contract.pluginId !== value.pluginId) {
      context.addIssue({
        code: 'custom',
        path: ['writableCollections', index, 'pluginId'],
        message: 'Intent writable collections must belong to the selected plugin.',
      });
    }
    const key = pluginCollectionContractKeyV1(contract);
    if (keys.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['writableCollections', index],
        message: 'Intent writable collections must be unique by plugin and collection.',
      });
    }
    keys.add(key);
  });
})));
export type PluginAccountPluginIntentV1 = z.infer<typeof PluginAccountPluginIntentV1Schema>;
