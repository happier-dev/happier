import {
  type ConnectedAccountDescriptor,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

type MaterializationKind = 'scm_hosting_token' | 'scm_hosting_basic_auth';

export type ResolvedConnectedAccountDescriptorContribution = Readonly<{
  provenance: 'first_party' | 'external';
  source: Readonly<{ kind: string }>;
  definition: ConnectedAccountDescriptor;
}>;

export type ResolvedPluginHookHandler = Readonly<{
  handler: (request: unknown) => unknown | Promise<unknown>;
}>;

export type ScmHostingAuthMaterializationRegistry = Readonly<{
  connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
  hookHandlersByHookId?: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
}>;

export type ScmHostingAuthMaterializerCandidate = Readonly<{
  serviceId: ConnectedServiceId;
  hookKey: string;
  handlers: readonly ResolvedPluginHookHandler[];
}>;

function collectConnectedAccountDescriptors(
  registry?: ScmHostingAuthMaterializationRegistry,
): readonly ResolvedConnectedAccountDescriptorContribution[] {
  return Object.freeze([...(registry?.connectedAccountDescriptors ?? [])]);
}

export function collectScmHostingAuthMaterializerCandidates(
  kind: MaterializationKind,
  registry?: ScmHostingAuthMaterializationRegistry,
): readonly ScmHostingAuthMaterializerCandidate[] {
  const handlersByHookId = registry?.hookHandlersByHookId;
  if (!handlersByHookId) return [];

  const candidates: ScmHostingAuthMaterializerCandidate[] = [];
  const seen = new Set<string>();
  for (const descriptor of collectConnectedAccountDescriptors(registry)) {
    const hookKey = descriptor.definition.materialization.hookKey;
    if (
      !hookKey
      || !descriptor.definition.materialization.materializationKinds.includes(kind)
      || seen.has(`${descriptor.definition.id}:${hookKey}`)
    ) {
      continue;
    }
    const handlers = handlersByHookId.get(hookKey) ?? [];
    if (handlers.length === 0) continue;
    candidates.push({
      serviceId: descriptor.definition.id as ConnectedServiceId,
      hookKey,
      handlers,
    });
    seen.add(`${descriptor.definition.id}:${hookKey}`);
  }
  return Object.freeze(candidates);
}
