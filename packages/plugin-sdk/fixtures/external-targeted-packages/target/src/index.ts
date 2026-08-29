import {
  definePlugin,
  type JsonValue,
  type PluginInvocationContext,
  type TargetedContributionPointRef,
} from '@happier-dev/plugin-sdk';
import type { AdmittedTargetedOperationExecutionHandle } from '@happier-dev/plugin-sdk/actions';
import {
  defineContributionPoint,
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  type SessionAuthoringCheckoutCreationDraftV1,
  type SessionSpawnNewInputV2,
} from '@happier-dev/plugin-sdk/sessions';

export {
  selectPhysicalCopyDetailSurface,
} from './targetedSurfaceSelection.js';

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const descriptorSchema = defineProtocolObject({
  kind: defineProtocolUnion([
    defineProtocolLiteral('issue'),
    defineProtocolLiteral('pull-request'),
  ]),
  label: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const detailInputSchema = defineProtocolObject({
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const inspectionInputSchema = defineProtocolObject({
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const inspectionResultSchema = defineProtocolObject({
  inspected: defineProtocolLiteral(true),
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const deliverResultSchema = defineProtocolObject({
  delivered: defineProtocolLiteral(true),
}, { policy: 'closed' });

/** This package owns an independent public wrapper for cross-copy proof. */
export const targetDiagnosticSchema = defineProtocolObject({
  diagnostic: defineProtocolUtf8String({ maxUtf8Bytes: 1_024, minLength: 1 }),
}, { policy: 'closed' });

export function serializeTargetDiagnostic(diagnostic: string): string {
  return JSON.stringify(targetDiagnosticSchema.parse({ diagnostic }));
}

export function parseTargetDiagnostic(serialized: string) {
  return targetDiagnosticSchema.safeParse(JSON.parse(serialized));
}

/** An external author uses the exact bounded checkout draft exposed by spawn. */
export const externalCheckoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1 = {
  kind: 'git_worktree',
  displayName: 'feature/external-copy',
  baseRef: 'main',
  branchMode: 'new',
};

export const externalSpawnInputWithCheckout: Pick<
  SessionSpawnNewInputV2,
  'checkoutCreationDraft'
> = {
  checkoutCreationDraft: externalCheckoutCreationDraft,
};

export function parseExternalCheckoutCreationDraft(
  value: unknown,
): SessionAuthoringCheckoutCreationDraftV1 {
  return SessionAuthoringCheckoutCreationDraftV1Schema.parse(value);
}

/** The target's separately installed SDK copy defines the target protocol. */
export const targetProtocol = defineContributionProtocol({
  id: 'physical-copy-sources',
  version: 1,
  descriptor: descriptorSchema,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: inspectionResultSchema,
      action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
    },
  },
  surfaces: {
    detail: {
      required: true,
      inputSchema: detailInputSchema,
      presentation: 'content',
    },
  },
});

/**
 * The declarative A renderer uses the same target-owned role that the public
 * React/RNW surface selects at runtime. It carries no renderer or generation
 * authority; the host rematches the current admitted contributor.
 */
export const physicalCopyTargetDetailNode = targetProtocol.surfaces.detail.node({
  pointId: 'sources',
  contributor: {
    pluginId: 'fixture.physical-copy-contributor',
    contributionId: 'physical-copy-source',
  },
  input: { entryId: 'external-42' },
  instanceKey: 'external-42',
  fallback: {
    kind: 'state',
    state: 'empty',
    title: 'External source detail unavailable',
  },
});

const targetProtocolV2 = defineContributionProtocol({
  id: 'physical-copy-sources',
  version: 2,
  operations: {
    deliver: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: deliverResultSchema,
      action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    },
  },
});

export const targetPlugin = definePlugin({
  id: 'fixture.physical-copy-target',
  version: '0.1.0',
  contributionPoints: {
    sources: defineContributionPoint([targetProtocol]),
  },
  ui: {
    renderers: [{
      id: 'physical-copy-target-react-renderer',
      kind: 'reactNative',
      artifact: 'physical-copy-target-react',
      requiredHostMethods: ['context'],
    }, {
      id: 'physical-copy-target-declarative-renderer',
      kind: 'declarative',
      root: physicalCopyTargetDetailNode,
    }],
    translations: [],
  },
});

export const { manifest, activate } = targetPlugin;

const multiEpochTarget = definePlugin({
  id: 'fixture.physical-copy-target-multi-epoch',
  version: '0.1.0',
  contributionPoints: {
    sources: defineContributionPoint([targetProtocol, targetProtocolV2]),
  },
});

const sourceContribution = targetProtocol.contribute({
  descriptor: { kind: 'issue', label: 'Source-only inference contribution' },
  operations: {
    inspect: targetProtocol.operations.inspect.bind('source-only-inspect'),
  },
  surfaces: {
    detail: { renderer: 'source-only-detail' },
  },
});

export const sourceContributor = definePlugin({
  id: 'fixture.physical-copy-source-only-contributor',
  version: '0.1.0',
  actions: {
    'source-only-inspect': {
      title: 'Inspect a source-only contribution',
      execution: { target: 'daemon' },
      surfaces: ['plugin', 'ui'],
      inputSchema: inspectionInputSchema,
      resultSchema: inspectionResultSchema,
      run: async (input) => ({ inspected: true, entryId: input.entryId }),
    },
  },
  ui: {
    renderers: [{
      id: 'source-only-detail',
      kind: 'declarative',
      root: { kind: 'text', text: 'Source-only detail' },
    }],
    translations: [],
  },
  contributesTo: {
    'fixture.physical-copy-target': {
      sources: {
        'source-only-contribution': sourceContribution,
      },
    },
  },
});

type TargetSource = typeof targetPlugin.contributionPoints.sources extends TargetedContributionPointRef<
  infer TContribution
> ? TContribution : never;
type _DescriptorInference = Expect<Equal<
  NonNullable<TargetSource['descriptor']>,
  { readonly kind: 'issue' | 'pull-request'; readonly label: string }
>>;
type _OperationInference = Expect<Equal<
  TargetSource['operations']['inspect'],
  AdmittedTargetedOperationExecutionHandle<
    JsonValue,
    { readonly inspected: true; readonly entryId: string },
    'inspect'
  >
>>;
type _SurfaceInference = Expect<Equal<
  TargetSource['surfaces']['detail']['presentation'],
  'content'
>>;
type V1Point = typeof multiEpochTarget.contributionPoints.sources.protocols[0];
type V2Point = typeof multiEpochTarget.contributionPoints.sources.protocols[1];
type _V1PointInference = Expect<Equal<V1Point['protocol']['version'], 1>>;
type _V2PointInference = Expect<Equal<V2Point['protocol']['version'], 2>>;
type _SourceContributorActionInference = Expect<Equal<
  typeof sourceContribution.operations.inspect,
  'source-only-inspect'
>>;

/** A target observes only the typed snapshot projected from its own point. */
export async function readTargetSourceSnapshot(context: PluginInvocationContext) {
  const observation = context.services.targetedContributions.observeForSelf(
    targetPlugin.contributionPoints.sources,
    { onInvalidated: () => undefined },
  );
  try {
    return await observation.readCurrent({ signal: context.signal });
  } finally {
    observation.dispose();
  }
}

type _ObservedSnapshotInference = Expect<Equal<
  Awaited<ReturnType<typeof readTargetSourceSnapshot>>['contributions'],
  readonly TargetSource[]
>>;

if (false) {
  targetProtocol.contribute({
    descriptor: {
      kind: 'issue',
      // @ts-expect-error Descriptor labels are strings.
      label: 42,
    },
    operations: {
      inspect: targetProtocol.operations.inspect.bind('source-only-inspect'),
    },
    surfaces: {
      detail: { renderer: 'source-only-detail' },
    },
  });

  targetProtocol.contribute({
    descriptor: { kind: 'issue', label: 'Missing required detail surface' },
    operations: {
      inspect: targetProtocol.operations.inspect.bind('source-only-inspect'),
    },
    // @ts-expect-error A required target-owned surface cannot be omitted.
    surfaces: {},
  });
}
