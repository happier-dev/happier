import {
  computeCanonicalDomainSeparatedDigest,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  triageSourceBindingComponentsV1,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';

/** The exact configured-source generation used by continuations and opaque candidates. */
export function deriveTriageConfiguredSourceInstanceDigestV1(
  instance: TriageConfiguredSourceInstanceV1,
): string {
  return computeCanonicalDomainSeparatedDigest(
    'happier.triage.configured-source-instance.v1',
    [
      String(instance.v),
      instance.instance.source.pluginId,
      instance.instance.source.localId,
      instance.instance.sourceInstanceId,
      ...triageSourceBindingComponentsV1(instance.binding),
      instance.localInstanceKey,
      String(instance.configuration.v),
      instance.configuration.token,
    ],
  );
}

export type CurrentTriageConfiguredSourceInstanceV1 =
  | Readonly<{ kind: 'current'; instance: TriageConfiguredSourceInstanceV1 }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'changed' }>;

/** Rereads one exact active configured row through the target-owned Action. */
export async function readCurrentTriageConfiguredSourceInstanceV1(input: Readonly<{
  context: PluginInvocationContext;
  sourceInstanceId: string;
  instanceDigest: string;
}>): Promise<CurrentTriageConfiguredSourceInstanceV1> {
  const raw = await input.context.services.actions.execute(
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    { v: 1 },
    { signal: input.context.signal },
  );
  const parsed = TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== 'read' || parsed.data.status !== 'complete') {
    return Object.freeze({ kind: 'unavailable' as const });
  }
  const matches = parsed.data.instances.filter((record) => (
    record.lifecycle === 'active'
    && record.configured.instance.sourceInstanceId === input.sourceInstanceId
    && deriveTriageConfiguredSourceInstanceDigestV1(record.configured) === input.instanceDigest
  ));
  return matches.length === 1
    ? Object.freeze({ kind: 'current' as const, instance: matches[0]!.configured })
    : Object.freeze({ kind: 'changed' as const });
}
