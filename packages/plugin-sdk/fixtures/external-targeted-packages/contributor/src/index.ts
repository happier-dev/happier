import {
  defineComposerAttachment,
  defineComposerControl,
  defineComposerReference,
  defineComposerRegion,
  definePlugin,
  type JsonValue,
  type PluginComposerAttachmentDefinition,
} from '@happier-dev/plugin-sdk';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  type ContributionSurfaceBinding,
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolArray,
  defineProtocolJsonValue,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';

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

/**
 * This contributor constructs the same public wrapper through its separate
 * SDK copy. Interoperation below is intentionally through JSON text, never a
 * shared leaf-schema object or a foreign schema instance.
 */
export const contributorDiagnosticSchema = defineProtocolObject({
  diagnostic: defineProtocolUtf8String({ maxUtf8Bytes: 1_024, minLength: 1 }),
}, { policy: 'closed' });
type _ContributorDiagnosticParseIsExact = Expect<Equal<
  ReturnType<typeof contributorDiagnosticSchema.parse>,
  { readonly diagnostic: string }
>>;

export function serializeContributorDiagnostic(diagnostic: string): string {
  return JSON.stringify(contributorDiagnosticSchema.parse({ diagnostic }));
}

export function parseContributorDiagnostic(serialized: string) {
  return contributorDiagnosticSchema.safeParse(JSON.parse(serialized));
}

/** This compatible protocol comes from the contributor's separate SDK copy. */
export const contributorProtocol = defineContributionProtocol({
  id: 'physical-copy-sources',
  version: 1,
  descriptor: descriptorSchema,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: inspectionResultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
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

const physicalCopyContribution = contributorProtocol.contribute({
  descriptor: { kind: 'issue', label: 'Physical package source' },
  operations: {
    inspect: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
  },
  surfaces: {
    detail: { renderer: 'physical-copy-detail-renderer' },
  },
});

type _ArbitraryActionIdIsRetained = Expect<Equal<
  typeof physicalCopyContribution.operations.inspect,
  'non-protocol-local-action'
>>;
type _DescriptorIsExact = Expect<Equal<
  NonNullable<typeof physicalCopyContribution.descriptor>,
  { readonly kind: 'issue' | 'pull-request'; readonly label: string }
>>;
type _SurfaceBindingIsExact = Expect<Equal<
  NonNullable<typeof physicalCopyContribution.surfaces>['detail'],
  ContributionSurfaceBinding<'physical-copy-detail-renderer'>
>>;

export const externalComposerReference = defineComposerReference({
  title: { key: 'external.sources.title', fallback: 'External sources' },
  description: {
    key: 'external.sources.description',
    fallback: 'Search external physical-package sources',
  },
  icon: 'search',
  triggers: ['@', '$'],
  search: async (query) => [{
    id: `source:${query}`,
    label: `External ${query}`,
    description: 'An independently authored source',
  }],
  resolve: async (candidateId) => ({
    id: candidateId,
    label: 'External source',
    description: 'An independently authored source',
    context: `Context for ${candidateId}`,
  }),
});

/**
 * This author uses the contributor package's own SDK copy. The JSON-schema
 * shorthand deliberately infers readonly JSON arrays, which catches a host
 * callback contract that accidentally requires Protocol's mutable JSON type.
 */
const readonlyDraftSchema = defineProtocolArray(defineProtocolJsonValue());
const readonlyPreparedSchema = defineProtocolArray(defineProtocolJsonValue());
export const externalReadonlyComposerAttachment = defineComposerAttachment({
  title: { key: 'external.readonly.title', fallback: 'External readonly attachment' },
  description: {
    key: 'external.readonly.description',
    fallback: 'A public readonly JSON attachment contract',
  },
  icon: 'file',
  cardinality: 'one',
  value: readonlyDraftSchema,
  preparedValue: readonlyPreparedSchema,
  picker: 'physical-copy-composer-renderer',
  display: { kind: 'badge' },
  preview: {
    kind: 'surface',
    renderer: 'physical-copy-composer-renderer',
    presentation: 'popover',
  },
  runtime: {
    prepareForSend: async (request) => ({
      attachments: request.attachments.map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready',
        value: attachment.value,
      })),
    }),
  },
});

type ComposerAttachmentValues<TAttachment> = TAttachment extends PluginComposerAttachmentDefinition<
  infer TDraft,
  infer TPrepared
> ? Readonly<{ draft: TDraft; prepared: TPrepared }> : never;
type _ReadonlyComposerValuesAreRetained = Expect<Equal<
  ComposerAttachmentValues<typeof externalReadonlyComposerAttachment>,
  Readonly<{ draft: readonly JsonValue[]; prepared: readonly JsonValue[] }>
>>;

export const externalComposerControl = defineComposerControl({
  label: { key: 'external.readonly.control', fallback: 'Choose external source' },
  icon: 'search',
  scopes: ['session'],
  order: 7,
  labelPolicy: 'always',
  interaction: {
    kind: 'surface',
    renderer: 'physical-copy-composer-renderer',
    presentation: 'popover',
    layout: 'content',
  },
  compactRenderer: 'physical-copy-composer-renderer',
  overflow: {
    label: { key: 'external.readonly.control.more', fallback: 'More external choices' },
    icon: 'more',
  },
});

export const externalComposerRegion = defineComposerRegion({
  placement: 'afterComposer',
  renderer: 'physical-copy-composer-renderer',
  scopes: ['session'],
  order: 8,
});

const externalExecutionRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: Object.freeze({
    async open() {
      throw new Error('External fixture does not execute the Agent runtime');
    },
  }),
});

/**
 * The full public External Sessions callback shape stays authorable from a
 * physical consumer package: six required callbacks and the optional managed
 * endpoint declaration callback, without a Protocol import.
 */
const physicalCopyExternalSessions = {
  async resolveSource(request) {
    return { ok: true, value: { source: request.source } };
  },
  async listCandidates() {
    return { ok: true, value: { candidates: [], nextCursor: null } };
  },
  async resolveLinkIdentity(request) {
    return {
      ok: true,
      value: {
        source: request.source,
        remoteSessionId: request.remoteSessionId,
        linkData: request.linkData ?? {},
      },
    };
  },
  async resolveLinkedIdentity(request) {
    return {
      ok: true,
      value: {
        source: request.source,
        remoteSessionId: request.remoteSessionId,
        linkData: request.linkData,
      },
    };
  },
  async pageTranscript() {
    return { ok: true, value: { items: [], nextCursor: null } };
  },
  async readAfterTranscript() {
    return { ok: true, value: { outcome: 'already_current' } };
  },
  async resolveManagedEndpointService() {
    return null;
  },
} satisfies AgentExternalSessionsContribution;

export const externalAgentPlugin = definePlugin({
  id: 'fixture.physical-copy-agent',
  version: '0.1.0',
  agents: {
    external: {
      declaration: {
        title: 'Physical-copy External Sessions Agent',
        runtime: { kind: 'custom' },
        primary: 'executionRuns',
        capabilities: {
          surfaces: ['externalSessions'],
          executionRuns: { open: ['create'], checkpoint: false, stop: true },
        },
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: 'physical-copy',
              schema: {
                fields: [{ name: 'kind', kind: 'literal', value: 'physical-copy' }],
              },
              key: { segments: [{ kind: 'field', field: 'kind' }] },
            }],
          },
        },
      },
      factory: externalExecutionRuntime,
      externalSessions: physicalCopyExternalSessions,
    },
  },
});

export const contributorPlugin = definePlugin({
  id: 'fixture.physical-copy-contributor',
  version: '0.1.0',
  actions: {
    'non-protocol-local-action': {
      title: 'Inspect an external source',
      surfaces: ['plugin'],
      inputSchema: inspectionInputSchema,
      resultSchema: inspectionResultSchema,
      run: async (input) => ({ inspected: true, entryId: input.entryId }),
    },
  },
  ui: {
    renderers: [{
      id: 'physical-copy-detail-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'External source detail' },
    }, {
      id: 'physical-copy-composer-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'External Composer surface' },
    }],
    translations: [],
  },
  composer: {
    references: {
      sources: externalComposerReference,
    },
    attachments: {
      'external-readonly': externalReadonlyComposerAttachment,
    },
    controls: {
      'external-readonly-control': externalComposerControl,
    },
    regions: {
      'external-readonly-region': externalComposerRegion,
    },
  },
  contributesTo: {
    'fixture.physical-copy-target': {
      sources: {
        'physical-copy-source': physicalCopyContribution,
      },
    },
  },
});

export const { manifest, activate } = contributorPlugin;

if (false) {
  contributorProtocol.contribute({
    descriptor: {
      kind: 'issue',
      // @ts-expect-error The target protocol's descriptor label is a string.
      label: 42,
    },
    operations: {
      inspect: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
    },
    surfaces: {
      detail: { renderer: 'physical-copy-detail-renderer' },
    },
  });

  contributorProtocol.contribute({
    descriptor: { kind: 'issue', label: 'Missing required surface' },
    operations: {
      inspect: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
    },
    // @ts-expect-error The target protocol requires the detail surface role.
    surfaces: {},
  });

  contributorProtocol.contribute({
    descriptor: { kind: 'issue', label: 'Unknown surface' },
    operations: {
      inspect: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
    },
    surfaces: {
      detail: { renderer: 'physical-copy-detail-renderer' },
      // @ts-expect-error A contributor cannot invent a target surface role.
      unexpected: { renderer: 'physical-copy-detail-renderer' },
    },
  });

  contributorProtocol.contribute({
    descriptor: { kind: 'issue', label: 'Unknown operation' },
    operations: {
      inspect: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
      // @ts-expect-error A contributor cannot invent a target operation role.
      unexpected: contributorProtocol.operations.inspect.bind('non-protocol-local-action'),
    },
    surfaces: {
      detail: { renderer: 'physical-copy-detail-renderer' },
    },
  });

  definePlugin({
    id: 'fixture.invalid-contributor-action-binding',
    version: '0.1.0',
    actions: {
      'declared-but-different-action': {
        title: 'Declared action',
        surfaces: ['plugin'],
        inputSchema: inspectionInputSchema,
        resultSchema: inspectionResultSchema,
        run: async (input) => ({ inspected: true, entryId: input.entryId }),
      },
    },
    contributesTo: {
      'fixture.physical-copy-target': {
        sources: {
          // @ts-expect-error A targeted operation may bind only this plugin's declared Action ids.
          'undeclared-action-binding': contributorProtocol.contribute({
            descriptor: { kind: 'issue', label: 'Undeclared action' },
            operations: {
              inspect: contributorProtocol.operations.inspect.bind('not-declared-here'),
            },
            surfaces: {
              detail: { renderer: 'physical-copy-detail-renderer' },
            },
          }),
        },
      },
    },
  });
}
