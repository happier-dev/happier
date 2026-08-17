import {
  definePlugin,
  type PluginInvocationContext,
  type TargetedContributionPointRef,
} from '@happier-dev/plugin-sdk';
import {
  type ContributionSurfaceNode,
  type ContributionSurfaceNodeInput,
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

const sourceDescriptorSchema = defineProtocolObject({
  label: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const detailInputSchema = defineProtocolObject({
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

/**
 * This is deliberately a feature-owned protocol value, not an Action scan or
 * renderer registry. A real target and contributor may carry compatible
 * copies; the host compares the serialized id and version at admission.
 */
const externalTriageSourcesV1 = defineContributionProtocol({
  id: 'example.external-triage-sources',
  version: 1,
  descriptor: sourceDescriptorSchema,
  operations: {},
  surfaces: {
    detail: {
      required: true,
      inputSchema: detailInputSchema,
      presentation: 'content',
    },
  },
});

export const externalTriageTarget = definePlugin({
  id: 'example.external-triage-target',
  version: '0.1.0',
  contributionPoints: {
    sources: externalTriageSourcesV1.point(),
  },
});

type ExternalTriageContribution = (
  typeof externalTriageTarget.contributionPoints.sources
) extends TargetedContributionPointRef<infer TContribution>
  ? TContribution
  : never;

/** The exact admitted detail handle reached through this target's own point. */
export type ExternalSourceDetailSurface = ExternalTriageContribution extends Readonly<{
  surfaces: Readonly<{ detail: infer TSurface }>;
}> ? TSurface : never;

/**
 * The target owns the public `.node(...)` input shape. Keeping this alias in
 * the emitted declaration proves external target helpers can name it without
 * reconstructing a Protocol-private declarative node type.
 */
export type ExternalSourceDetailNodeInput = ContributionSurfaceNodeInput<Readonly<{
  entryId: string;
}>>;

/**
 * Real target-local observation traversal. This is intentionally separate
 * from the React compile fixture so its surface type cannot be fabricated by
 * a hand-written handle literal.
 */
export async function readExternalSourceDetailSurface(
  context: PluginInvocationContext,
): Promise<ExternalSourceDetailSurface | null> {
  const observation = context.services.targetedContributions.observeForSelf(
    externalTriageTarget.contributionPoints.sources,
    { onInvalidated: () => undefined },
  );
  try {
    const contribution = (await observation.readCurrent({ signal: context.signal })).contributions[0];
    return contribution?.surfaces.detail ?? null;
  } finally {
    observation.dispose();
  }
}

/**
 * An external target reads only its own admitted point. The returned node is
 * symbolic: it contains no renderer, artifact, generation, or mount owner;
 * the host rematches the exact current admitted surface when it renders it.
 */
export async function buildContributedDetailNode(
  context: PluginInvocationContext,
  entryId: string,
): Promise<ContributionSurfaceNode<Readonly<{ entryId: string }>> | null> {
  const surface = await readExternalSourceDetailSurface(context);
  if (surface === null) return null;

  const nodeInput: ExternalSourceDetailNodeInput = {
    pointId: surface.point.pointId,
    contributor: {
      pluginId: surface.contributor.pluginId,
      contributionId: surface.contributor.contributionId,
    },
    input: { entryId },
    instanceKey: entryId,
    fallback: { kind: 'state', state: 'loading', title: 'Loading source detail' },
  };
  return externalTriageSourcesV1.surfaces.detail.node(nodeInput);
}

if (false) {
  definePlugin({
    id: 'example.external-triage-interceptor',
    version: '0.1.0',
    requestInterceptors: {
      'triage-api-policy': {
        declaration: {
          origins: ['https://api.example.test'],
          methods: ['GET'],
        },
        interceptor: (request) => ({
          decision: 'continue',
          request,
        }),
      },
    },
  });
}
