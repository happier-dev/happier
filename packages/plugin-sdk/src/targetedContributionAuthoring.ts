import {
    PluginContributionLocalIdSchema,
    PluginContributionOperationRoleV1Schema,
    PluginContributionProtocolIdV1Schema,
} from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { cloneStrictPluginJsonValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    PluginTargetedContributionSelectionV1Schema as canonicalPluginTargetedContributionSelectionV1Schema,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';

import type { AdmittedTargetedOperationExecutionHandle } from './actions/admittedTargetedOperation.js';
import { readProtocolComposableSchema } from './protocol/protocolFacade.js';
import type {
    PluginJsonSchema,
    ProtocolJsonValue as JsonValue,
    ProtocolComposableSchema,
    ProtocolSchemaInput,
    ProtocolSchemaOutput,
} from './protocol/protocolFacade.js';
import type { TargetedContributionPointRef } from './services/targetedContributions.js';

/**
 * Portable selection fact shared with the Protocol UI contract. The SDK owns
 * this public structural spelling so installed author declarations never need
 * to resolve a Protocol-private module path.
 */
export type PluginTargetedContributionSelectionV1 = Readonly<{
    target: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
    }>;
    point: Readonly<{
        pointId: string;
        protocol: Readonly<{
            id: string;
            version: number;
        }>;
    }>;
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
}>;

/** The canonical Protocol parser remains the sole schema owner. */
export const PluginTargetedContributionSelectionV1Schema: ProtocolComposableSchema<PluginTargetedContributionSelectionV1> =
    canonicalPluginTargetedContributionSelectionV1Schema;

const TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_KIND =
    'happier.pluginSdk.targetedContributionPointSemantics' as const;
const TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_VERSION = 1 as const;
const TARGETED_CONTRIBUTION_SEMANTIC_REFS_FIELD = 'semanticPointRefs' as const;

/**
 * `.node(...)` snapshots an author-provided declarative node through the one
 * Protocol strict-JSON owner. The SDK only preserves its public error class;
 * structural admission, cloning, and immutability remain Protocol-owned.
 */
function cloneTargetedSurfaceNode<T>(value: T): T {
    try {
        return cloneStrictPluginJsonValue(value, 'targeted Surface node') as T;
    } catch (error) {
        throw new TypeError(error instanceof Error ? error.message : 'Targeted Surface node authoring is invalid');
    }
}

function createTargetedSurfaceNode<TInput extends JsonValue>(input: Readonly<{
    pointId: string;
    protocol: Readonly<{ id: string; version: number }>;
    contributor: Readonly<{ pluginId: string; contributionId: string }>;
    role: string;
    value: TInput;
    instanceKey: string;
    fallback?: ContributionSurfaceFallback;
}>): ContributionSurfaceNode<TInput> {
    const node: ContributionSurfaceNode<TInput> = {
        kind: 'targetedSurface',
        surface: {
            point: {
                pointId: input.pointId,
                protocol: input.protocol,
            },
            contributor: input.contributor,
            role: input.role,
        },
        input: input.value,
        instanceKey: input.instanceKey,
        ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    };
    return cloneTargetedSurfaceNode(node);
}

type ProjectedContributionOperation = Readonly<{
    required: boolean;
    input: Readonly<{ kind: 'contributorDefined' }>
        | Readonly<{ kind: 'protocolDefined'; schema: PluginJsonSchema }>;
    resultSchema: PluginJsonSchema;
    action: Readonly<{
        surface: ContributionActionSurface;
        dangerLevel: ContributionActionDangerLevel;
    }>;
}>;

type ProjectedContributionSurface = Readonly<{
    required: boolean;
    inputSchema: PluginJsonSchema;
    presentation: ContributionSurfacePresentation;
}>;

type ProjectedRendererChainBinding = Readonly<{
    renderer: string;
    fallbackRenderers?: readonly string[];
}>;

/**
 * The SDK-owned public projection of a target protocol declaration. Runtime
 * manifest validation remains Protocol-owned; this type prevents author
 * declaration output from exposing that package's internal manifest paths.
 */
export type ContributionProtocolManifest = Readonly<{
    id: string;
    version: number;
    descriptor?: object;
    operations: Readonly<Record<string, Readonly<{
        required: boolean;
        input: Readonly<{ kind: 'contributorDefined' }>
            | Readonly<{ kind: 'protocolDefined'; schema: PluginJsonSchema }>;
        resultSchema: PluginJsonSchema;
        action: Readonly<{
            surface: ContributionActionSurface;
            dangerLevel: ContributionActionDangerLevel;
        }>;
    }>>>;
    surfaces?: Readonly<Record<string, Readonly<{
        required: boolean;
        inputSchema: PluginJsonSchema;
        presentation: ContributionSurfacePresentation;
    }>>>;
}>;

export type ContributionPointOptions = Readonly<{
    maxContributionsPerContributor?: number;
}>;

export type SchemaInput<TSchema> = [ProtocolSchemaInput<TSchema>] extends [never]
    ? JsonValue
    : ProtocolSchemaInput<TSchema>;
export type SchemaOutput<TSchema> = [ProtocolSchemaOutput<TSchema>] extends [never]
    ? JsonValue
    : ProtocolSchemaOutput<TSchema>;

/**
 * A declared descriptor schema is a REQUIRED contribution field: the protocol
 * has no optionality flag, so declaring the schema is the declaration that
 * every contributor must carry one. A protocol without a schema forbids the
 * field entirely.
 */
export type DescriptorFields<TDescriptorSchema> =
    TDescriptorSchema extends ProtocolComposableSchema<unknown, unknown>
        ? Readonly<{ descriptor: ReturnType<TDescriptorSchema['parse']> }>
        : Readonly<{ descriptor?: never }>;

/** The Action presentation surface accepted by one cross-plugin operation role. */
export type ContributionActionSurface = 'cli' | 'mcp' | 'agent' | 'ui' | 'plugin';

/** The side-effect level accepted by one cross-plugin operation role. */
export type ContributionActionDangerLevel =
    | 'safe'
    | 'writesLocal'
    | 'writesRemote'
    | 'externalSideEffect'
    | 'destructive';

/** A protocol-owned non-navigable surface presentation. */
export type ContributionSurfacePresentation = 'content' | 'fill';

/**
 * @realm daemon
 *
 * One target-declared surface retained by the daemon-only semantic reader.
 */
export type TargetedContributionPointSemanticSurface = Readonly<{
    role: string;
    presentation: ContributionSurfacePresentation;
}>;

/**
 * @realm daemon
 *
 * One executable target-operation contract retained only through the host's
 * exact-generation admitted-operation binding. It is never a manifest field,
 * public handle property, or contributor-provided assertion.
 */
export type TargetedContributionPointSemanticOperation = Readonly<{
    role: string;
    input: Readonly<{ kind: 'contributorDefined' }>
        | Readonly<{
            kind: 'protocolDefined';
            schema: ProtocolComposableSchema<JsonValue, JsonValue>;
        }>;
    resultSchema: ProtocolComposableSchema<JsonValue, JsonValue>;
}>;

/**
 * @realm daemon
 *
 * The already-admitted, host-private fields that a target point may project
 * through its executable protocol definition. This is not a manifest parser
 * and intentionally contains no contributor or renderer authority.
 */
export type TargetedContributionPointSemanticInput = Readonly<{
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: unknown;
    /** The exact target-declared operation-role set from cold manifest admission. */
    operations: readonly Readonly<{
        role: string;
    }>[];
    /** Future roles remain structurally transportable so older targets can ignore them. */
    surfaces: readonly Readonly<{
        role: string;
        presentation: string;
    }>[];
}>;

type TargetedContributionDescriptorFor<TContribution> = [TContribution] extends [Readonly<{
    descriptor?: infer TDescriptor;
}>] ? TDescriptor : JsonValue;

/**
 * @realm daemon
 *
 * The descriptor/surface/operation facts a target daemon can safely project
 * from one admitted entry. Operation schemas remain host-private and are
 * carried only to the opaque Action handle binding.
 */
export type TargetedContributionPointSemanticProjection<TContribution = unknown> = Readonly<{
    descriptor?: TargetedContributionDescriptorFor<TContribution>;
    operations: readonly TargetedContributionPointSemanticOperation[];
    surfaces: readonly TargetedContributionPointSemanticSurface[];
}>;

/** Public plain-data wording accepted by the symbolic fallback state. */
export type ContributionSurfaceLocalizedString = string | Readonly<{
    key: string;
    fallback: string;
}>;

/** Public icon vocabulary accepted by the symbolic fallback state. */
export type ContributionSurfaceIcon =
    | 'action'
    | 'browser'
    | 'copy'
    | 'file'
    | 'globe'
    | 'info'
    | 'preview'
    | 'refresh'
    | 'settings'
    | 'terminal'
    | 'warning'
    | 'add'
    | 'back'
    | 'check'
    | 'close'
    | 'error'
    | 'external'
    | 'forward'
    | 'more'
    | 'search';

/**
 * The one state-node form a symbolic contribution surface can carry as a
 * fallback. Its runtime validation remains the manifest parser's job; this
 * structural public vocabulary prevents external declarations from naming a
 * Protocol-private declarative node type.
 */
export type ContributionSurfaceFallback = Readonly<{
    kind: 'state';
    state: 'empty' | 'loading' | 'error';
    title: ContributionSurfaceLocalizedString;
    description?: ContributionSurfaceLocalizedString;
    icon?: ContributionSurfaceIcon;
}>;

/** One operation contract inside a cross-plugin contribution protocol. */
export type ContributionOperationDefinition<
    TInput extends JsonValue = JsonValue,
    TResult extends JsonValue = JsonValue,
> = Readonly<{
    required: boolean;
    input:
        | Readonly<{ kind: 'contributorDefined' }>
        | Readonly<{
            kind: 'protocolDefined';
            schema: ProtocolComposableSchema<TInput>;
        }>;
    resultSchema: ProtocolComposableSchema<JsonValue, TResult>;
    action: Readonly<{
        surface: ContributionActionSurface;
        dangerLevel: ContributionActionDangerLevel;
    }>;
}>;

/** One target-owned embedded surface contract; selection still belongs to `ui.renderers`. */
export type ContributionSurfaceDefinition<TInput extends JsonValue = JsonValue> = Readonly<{
    required: boolean;
    inputSchema: ProtocolComposableSchema<TInput>;
    presentation: ContributionSurfacePresentation;
}>;

/** A contributor binding to one already-declared same-plugin renderer chain. */
export type ContributionSurfaceBinding<TRendererLocalId extends string = string> = Readonly<{
    renderer: TRendererLocalId;
    fallbackRenderers?: readonly TRendererLocalId[];
}>;

export type ContributionProtocolDefinition<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<Record<string, never>>,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
    TProtocolId extends string = string,
    TProtocolVersion extends number = number,
> = Readonly<{
    id: TProtocolId;
    version: TProtocolVersion;
    descriptor?: TDescriptorSchema;
    operations: TOperations;
    surfaces?: TSurfaces;
}>;

/**
 * A helper-produced target declaration. The protocol tuple preserves exact
 * author inference. Its host-only semantic carrier is intentionally not part
 * of the public authoring shape and never enters canonical JSON.
 */
export type ContributionPointAuthorDefinition<
    TProtocols extends readonly unknown[] = readonly unknown[],
> = Readonly<{
    maxContributionsPerContributor?: number;
    protocols: readonly ContributionProtocolManifest[];
    readonly __protocols?: TProtocols;
}>;

type ContributionPointDefinitionWithSemanticCarrier<
    TProtocols extends readonly unknown[] = readonly unknown[],
> = ContributionPointAuthorDefinition<TProtocols> & Readonly<{
    semanticCarrier: readonly unknown[];
}>;

type TargetedContributionProtocolSemanticSurface = Readonly<{
    required: boolean;
    presentation: ContributionSurfacePresentation;
}>;

type TargetedContributionProtocolSemanticOperation = Readonly<{
    input: TargetedContributionPointSemanticOperation['input'];
    resultSchema: TargetedContributionPointSemanticOperation['resultSchema'];
}>;

/**
 * Target-authored executable facts. They never enter the cold manifest;
 * `definePlugin` attaches the derived carrier only to its live point ref.
 */
type TargetedContributionProtocolSemanticFact = Readonly<{
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: ProtocolComposableSchema<JsonValue, JsonValue>;
    operations: Readonly<Record<string, TargetedContributionProtocolSemanticOperation>>;
    surfaces: Readonly<Record<string, TargetedContributionProtocolSemanticSurface>>;
}>;

type TargetedContributionPointSemanticCarrier = Readonly<{
    kind: typeof TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_KIND;
    version: typeof TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_VERSION;
    targetPluginId: string;
    id: string;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: ProtocolComposableSchema<JsonValue, JsonValue>;
    operations: Readonly<Record<string, TargetedContributionProtocolSemanticOperation>>;
    surfaces: Readonly<Record<string, TargetedContributionProtocolSemanticSurface>>;
}>;

/** Required operation roles are statically required; optional roles remain optional. */
export type ContributionOperationBindings<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    TActionLocalId extends string,
> = Readonly<{
    [TRole in keyof TOperations & string as TOperations[TRole] extends Readonly<{
        required: true;
    }> ? TRole : never]: TActionLocalId;
} & {
    [TRole in keyof TOperations & string]?: TActionLocalId;
}>;

export type IsRequiredSurfaceDefinition<TDefinition> = [TDefinition] extends [never]
    ? false
    : TDefinition extends Readonly<{ required: true }> ? true : false;

export type RequiredSurfaceRoles<TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>>> = {
    [TRole in keyof TSurfaces & string]: IsRequiredSurfaceDefinition<TSurfaces[TRole]> extends true
        ? TRole
        : never;
}[keyof TSurfaces & string];

/** Required surface roles are statically required; optional roles remain optional. */
export type ContributionSurfaceBindings<
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>>,
    TRendererLocalId extends string,
> = Readonly<{
    [TRole in keyof TSurfaces & string as IsRequiredSurfaceDefinition<TSurfaces[TRole]> extends true
        ? TRole
        : never]: ContributionSurfaceBinding<TRendererLocalId>;
} & {
    [TRole in keyof TSurfaces & string]?: ContributionSurfaceBinding<TRendererLocalId>;
}>;

export type SurfaceFields<
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>>,
    TRendererLocalId extends string,
> = [TSurfaces[keyof TSurfaces & string]] extends [never]
    ? Readonly<{ surfaces?: never }>
    : [RequiredSurfaceRoles<TSurfaces>] extends [never]
        ? Readonly<{ surfaces?: ContributionSurfaceBindings<TSurfaces, TRendererLocalId> }>
        : Readonly<{ surfaces: ContributionSurfaceBindings<TSurfaces, TRendererLocalId> }>;

export type ContributionContributeInput<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>>,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined,
    TActionLocalId extends string,
    TRendererLocalId extends string,
> = Readonly<{
    operations: ContributionOperationBindings<TOperations, TActionLocalId>;
} & DescriptorFields<TDescriptorSchema> & SurfaceFields<TSurfaces, TRendererLocalId>>;

/** A helper-produced contributor declaration with exact author-side role typing. */
export type ContributionAuthorDefinition<
    TActionLocalId extends string = string,
    TRendererLocalId extends string = string,
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>> = Readonly<
        Record<string, ContributionOperationDefinition>
    >,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<
        Record<string, ContributionSurfaceDefinition>
    >,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
> = Readonly<{
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    operations: ContributionOperationBindings<TOperations, TActionLocalId>;
} & DescriptorFields<TDescriptorSchema> & SurfaceFields<TSurfaces, TRendererLocalId>>;

/** The only `contributesTo` shape accepted by `definePlugin`. */
export type ContributionAuthorTargets<
    TActionLocalId extends string = never,
    TRendererLocalId extends string = string,
> = Readonly<Record<string, Readonly<Record<string, Readonly<Record<
    string,
    ContributionAuthorDefinition<
        TActionLocalId,
        TRendererLocalId,
        Readonly<Record<string, ContributionOperationDefinition>>,
        Readonly<Record<string, ContributionSurfaceDefinition>>,
        ProtocolComposableSchema<JsonValue, JsonValue> | undefined
    >
>>>>>>;

/** A target-owned protocol surface role. Declarative `.node(...)` composition extends this value in EU-28. */
export type ContributionSurfaceNodeInput<TInput extends JsonValue = JsonValue> = Readonly<{
    pointId: string;
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
    }>;
    input: TInput;
    instanceKey: string;
    fallback?: ContributionSurfaceFallback;
}>;

/**
 * A public symbolic node emitted by a contribution-surface role. It is
 * structural on purpose: the Protocol manifest validator remains the sole
 * runtime grammar owner, while an external declaration never needs to name a
 * Protocol-private UI value type.
 */
export type ContributionSurfaceNode<TInput extends JsonValue = JsonValue> = Readonly<{
    kind: 'targetedSurface';
    surface: Readonly<{
        point: Readonly<{
            pointId: string;
            protocol: Readonly<{
                id: string;
                version: number;
            }>;
        }>;
        contributor: Readonly<{
            pluginId: string;
            contributionId: string;
        }>;
        role: string;
    }>;
    input: TInput;
    instanceKey: string;
    fallback?: ContributionSurfaceFallback;
}>;

export type ContributionSurfaceRole<
    TInput extends JsonValue = JsonValue,
    TPresentation extends ContributionSurfacePresentation = ContributionSurfacePresentation,
> = Readonly<{
    required: boolean;
    inputSchema: ProtocolComposableSchema<TInput>;
    presentation: TPresentation;
    /**
     * Creates the canonical symbolic declarative node. The mounted target
     * inventory later resolves its contributor generation and renderer.
     */
    node(input: ContributionSurfaceNodeInput<TInput>): ContributionSurfaceNode<TInput>;
}>;

/**
 * One target-owned operation role as it is consumed by a contributor's normal
 * Action declaration. This is authoring-only evidence: manifest projection
 * still serializes only the bounded JSON Schema form.
 */
export type ContributionOperationRole<
    TOperation extends ContributionOperationDefinition = ContributionOperationDefinition,
> = Readonly<{
    declaration: Readonly<{
        required: TOperation['required'];
        input: TOperation['input'];
        resultSchema: TOperation['resultSchema'];
        dangerLevel: TOperation['action']['dangerLevel'];
        surfaces: readonly [TOperation['action']['surface']];
    }>;
    bind<TActionLocalId extends string>(actionLocalId: TActionLocalId): TActionLocalId;
}>;

/**
 * One declared protocol epoch. This is an interface so external declaration
 * emit retains the public protocol name instead of structurally expanding its
 * private helper evidence.
 */
export interface ContributionProtocol<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>> = Readonly<
        Record<string, ContributionOperationDefinition>
    >,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<
        Record<string, ContributionSurfaceDefinition>
    >,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
    TProtocolId extends string = string,
    TProtocolVersion extends number = number,
> {
    readonly id: TProtocolId;
    readonly version: TProtocolVersion;
    readonly descriptor?: TDescriptorSchema;
    readonly operations: Readonly<{
        [TRole in keyof TOperations & string]: ContributionOperationRole<TOperations[TRole]>;
    }>;
    readonly surfaces: Readonly<{
        [TRole in keyof TSurfaces & string]: ContributionSurfaceRole<
            SchemaInput<TSurfaces[TRole]['inputSchema']>,
            TSurfaces[TRole]['presentation']
        >;
    }>;
    readonly point: (options?: ContributionPointOptions) => ContributionPointAuthorDefinition<
        readonly [ContributionProtocol<
            TOperations,
            TSurfaces,
            TDescriptorSchema,
            TProtocolId,
            TProtocolVersion
        >]
    >;
    readonly contribute: <TActionLocalId extends string, TRendererLocalId extends string>(
        input: ContributionContributeInput<
            TOperations,
            TSurfaces,
            TDescriptorSchema,
            TActionLocalId,
            TRendererLocalId
        >,
    ) => ContributionAuthorDefinition<
        TActionLocalId,
        TRendererLocalId,
        TOperations,
        TSurfaces,
        TDescriptorSchema
    >;
}

/** Typed opaque bindings around exact admitted operations; invocation remains with the existing Action executor. */
export type ContributionOperationContracts<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
> = Readonly<{
    [TRole in keyof TOperations & string as TOperations[TRole] extends Readonly<{
        required: true;
    }> ? TRole : never]: AdmittedTargetedOperationExecutionHandle<
        TOperations[TRole]['input'] extends Readonly<{
            kind: 'protocolDefined';
            schema: infer TInputSchema;
        }> ? SchemaInput<TInputSchema> : JsonValue,
        SchemaOutput<TOperations[TRole]['resultSchema']>,
        TRole
    >;
} & {
    [TRole in keyof TOperations & string as TOperations[TRole] extends Readonly<{
        required: true;
    }> ? never : TRole]?: AdmittedTargetedOperationExecutionHandle<
        TOperations[TRole]['input'] extends Readonly<{
            kind: 'protocolDefined';
            schema: infer TInputSchema;
        }> ? SchemaInput<TInputSchema> : JsonValue,
        SchemaOutput<TOperations[TRole]['resultSchema']>,
        TRole
    >;
}>;

/**
 * A target-local admitted surface handle. It is deliberately unable to reveal
 * renderer/artifact/materialization/credential/controller or Action authority.
 * Its declaration-only nominal carrier retains the surface input type without
 * exposing a runtime materialization handle.
 */
export declare abstract class ContributionSurfaceHandle<
    TInput extends JsonValue = JsonValue,
    TPointId extends string = string,
    TPresentation extends ContributionSurfacePresentation = ContributionSurfacePresentation,
> {
    protected readonly opaqueInput: TInput;
    point: Readonly<{
        pointId: TPointId;
        protocol: Readonly<{
            id: string;
            version: number;
        }>;
    }>;
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    role: string;
    presentation: TPresentation;
}

export type ContributionSurfaceHandles<
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>>,
    TPointId extends string = string,
> = Readonly<{
    [TRole in keyof TSurfaces & string as TSurfaces[TRole] extends Readonly<{
        required: true;
    }> ? TRole : never]: ContributionSurfaceHandle<
        SchemaInput<TSurfaces[TRole]['inputSchema']>,
        TPointId,
        TSurfaces[TRole]['presentation']
    >;
} & {
    [TRole in keyof TSurfaces & string as TSurfaces[TRole] extends Readonly<{
        required: true;
    }> ? never : TRole]?: ContributionSurfaceHandle<
        SchemaInput<TSurfaces[TRole]['inputSchema']>,
        TPointId,
        TSurfaces[TRole]['presentation']
    >;
}>;

/** One current admitted contributor at a target-owned point. */
export type ContributionAdmittedEntry<
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<
        Record<string, ContributionSurfaceDefinition>
    >,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
    TPointId extends string = string,
> = Readonly<{
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    operations: ContributionOperationContracts<TOperations>;
    surfaces: ContributionSurfaceHandles<TSurfaces, TPointId>;
} & DescriptorFields<TDescriptorSchema>>;

/** A target-local typed ref created only by `definePlugin` from a keyed point. */
export type DefinedContributionPointRef<
    TPluginId extends string,
    TPointId extends string,
    TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<
        Record<string, ContributionSurfaceDefinition>
    >,
    TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
    TProtocolId extends string = string,
    TProtocolVersion extends number = number,
> = Omit<TargetedContributionPointRef<
    ContributionAdmittedEntry<TOperations, TSurfaces, TDescriptorSchema, TPointId>
>, 'targetPluginId' | 'protocol'> & Readonly<{
    readonly targetPluginId: TPluginId;
    readonly id: TPointId;
    readonly protocol: Readonly<{
        id: TProtocolId;
        version: TProtocolVersion;
    }>;
}>;

export type PublicContributionProtocol<TProtocol> = TProtocol extends ContributionProtocol<
    infer TOperations,
    infer TSurfaces,
    infer TDescriptorSchema,
    infer TProtocolId,
    infer TProtocolVersion
>
    ? ContributionProtocol<TOperations, TSurfaces, TDescriptorSchema, TProtocolId, TProtocolVersion>
    : never;

export type PublicContributionProtocols<TProtocols extends readonly unknown[]> = Readonly<{
    [TIndex in keyof TProtocols]: PublicContributionProtocol<TProtocols[TIndex]>;
}>;

/**
 * The public, declaration-emittable protocol projection of helper-branded
 * author point definitions. `definePlugin` returns this projection rather
 * than leaking the private helper evidence used only to admit its input.
 */
export type DefinedContributionPointProtocolMap<
    TPoints extends Readonly<Record<string, ContributionPointAuthorDefinition>>,
> = Readonly<{
    [TPointId in keyof TPoints & string]: TPoints[TPointId] extends ContributionPointAuthorDefinition<
        infer TProtocols
    > ? TProtocols extends readonly unknown[]
        ? PublicContributionProtocols<TProtocols>
        : never
    : never;
}>;

export type DefinedContributionPoints<
    TPluginId extends string,
    TPointProtocols extends Readonly<Record<string, readonly unknown[]>>,
> = Readonly<{
    [TPointId in keyof TPointProtocols & string]: TPointProtocols[TPointId] extends readonly [infer TProtocol]
        ? TProtocol extends ContributionProtocol<
            infer TOperations,
            infer TSurfaces,
            infer TDescriptorSchema,
            infer TProtocolId,
            infer TProtocolVersion
        >
            ? DefinedContributionPointRef<
                TPluginId,
                TPointId,
                TOperations,
                TSurfaces,
                TDescriptorSchema,
                TProtocolId,
                TProtocolVersion
            >
            : never
        : Readonly<{
            readonly protocols: Readonly<{
                [TIndex in keyof TPointProtocols[TPointId]]: TPointProtocols[TPointId][TIndex] extends ContributionProtocol<
                    infer TOperations,
                    infer TSurfaces,
                    infer TDescriptorSchema,
                    infer TProtocolId,
                    infer TProtocolVersion
                > ? DefinedContributionPointRef<
                    TPluginId,
                    TPointId,
                    TOperations,
                    TSurfaces,
                    TDescriptorSchema,
                    TProtocolId,
                    TProtocolVersion
                > : never;
            }>;
        }>
}>;

function requireExecutableProtocolSchema<TInput extends JsonValue = JsonValue, TOutput extends JsonValue = TInput>(
    value: unknown,
    label: string,
): ProtocolComposableSchema<TInput, TOutput> {
    const schema = readProtocolComposableSchema<TInput, TOutput>(value);
    if (schema === undefined) throw new TypeError(`${label} must be an executable protocol schema`);
    return schema;
}

function resolveTargetedContributionOperationSemantics(
    operation: ContributionOperationDefinition,
): TargetedContributionProtocolSemanticOperation {
    const input = operation.input.kind === 'contributorDefined'
        ? Object.freeze({ kind: 'contributorDefined' as const })
        : Object.freeze({
            kind: 'protocolDefined' as const,
            schema: requireExecutableProtocolSchema(
                operation.input.schema,
                'Operation input schema',
            ),
        });
    return Object.freeze({
        input,
        resultSchema: requireExecutableProtocolSchema(
            operation.resultSchema,
            'Operation result schema',
        ),
    });
}

function projectOperation(operation: ContributionOperationDefinition): ProjectedContributionOperation {
    const input = operation.input.kind === 'protocolDefined'
        ? Object.freeze({
            kind: 'protocolDefined' as const,
            schema: requireExecutableProtocolSchema(operation.input.schema, 'Operation input schema').jsonSchema,
        })
        : Object.freeze({ kind: 'contributorDefined' as const });
    return Object.freeze({
        required: operation.required,
        input,
        resultSchema: requireExecutableProtocolSchema(operation.resultSchema, 'Operation result schema').jsonSchema,
        action: Object.freeze({
            surface: operation.action.surface,
            dangerLevel: operation.action.dangerLevel,
        }),
    });
}

function projectSurface(surface: ContributionSurfaceDefinition): ProjectedContributionSurface {
    return Object.freeze({
        required: surface.required,
        inputSchema: requireExecutableProtocolSchema(surface.inputSchema, 'Surface input schema').jsonSchema,
        presentation: surface.presentation,
    });
}

function projectSurfaceBindings(
    bindings: Readonly<Record<string, ContributionSurfaceBinding>> | undefined,
): Readonly<Record<string, ProjectedRendererChainBinding>> | undefined {
    if (bindings === undefined) return undefined;
    const projected: Record<string, ProjectedRendererChainBinding> = {};
    for (const [role, binding] of Object.entries(bindings)) {
        projected[role] = binding.fallbackRenderers === undefined
            ? { renderer: binding.renderer }
            : { renderer: binding.renderer, fallbackRenderers: [...binding.fallbackRenderers] };
    }
    return Object.freeze(projected);
}

/**
 * Target semantics cross independently installed SDK copies in-process. Their
 * carrier is an interoperability value, so decoding validates consumed fields
 * rather than object topology, frozen state, or property descriptors.
 */
function isSemanticRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRuntimeProtocolIdentity(value: unknown): Readonly<{
    id: string;
    version: number;
}> | null {
    if (!isSemanticRecord(value)) return null;
    const id = value['id'];
    const version = value['version'];
    if (typeof id !== 'string' || typeof version !== 'number'
        || !PluginContributionProtocolIdV1Schema.safeParse(id).success
        || !Number.isSafeInteger(version) || version <= 0) return null;
    return Object.freeze({ id, version });
}

function sameProtocolIdentity(
    left: Readonly<{ id: string; version: number }>,
    right: Readonly<{ id: string; version: number }>,
): boolean {
    return left.id === right.id && left.version === right.version;
}

function readRuntimeSemanticSurfaces(
    value: unknown,
): Readonly<Record<string, TargetedContributionProtocolSemanticSurface>> | null {
    if (!isSemanticRecord(value)) return null;
    const surfaces: Record<string, TargetedContributionProtocolSemanticSurface> = {};
    for (const [role, requirement] of Object.entries(value)) {
        if (!PluginContributionLocalIdSchema.safeParse(role).success
            || !isSemanticRecord(requirement)) return null;
        const required = requirement['required'];
        const presentation = requirement['presentation'];
        if (typeof required !== 'boolean'
            || (presentation !== 'content' && presentation !== 'fill')) {
            return null;
        }
        surfaces[role] = Object.freeze({ required, presentation });
    }
    return Object.freeze(surfaces);
}

function readRuntimeSemanticOperations(
    value: unknown,
): Readonly<Record<string, TargetedContributionProtocolSemanticOperation>> | null {
    if (!isSemanticRecord(value)) return null;
    const operations: Record<string, TargetedContributionProtocolSemanticOperation> = {};
    for (const [role, operation] of Object.entries(value)) {
        if (!PluginContributionOperationRoleV1Schema.safeParse(role).success
            || !isSemanticRecord(operation)) return null;
        const rawInput = operation['input'];
        if (!isSemanticRecord(rawInput)) return null;
        const inputKind = rawInput['kind'];
        let input: TargetedContributionProtocolSemanticOperation['input'];
        if (inputKind === 'contributorDefined') {
            input = Object.freeze({ kind: 'contributorDefined' as const });
        } else if (inputKind === 'protocolDefined') {
            try {
                input = Object.freeze({
                    kind: 'protocolDefined' as const,
                    schema: requireExecutableProtocolSchema(
                        rawInput['schema'],
                        'Operation input schema',
                    ),
                });
            } catch {
                return null;
            }
        } else {
            return null;
        }

        let resultSchema: ProtocolComposableSchema<JsonValue, JsonValue>;
        try {
            resultSchema = requireExecutableProtocolSchema(
                operation['resultSchema'],
                'Operation result schema',
            );
        } catch {
            return null;
        }
        operations[role] = Object.freeze({ input, resultSchema });
    }
    return Object.freeze(operations);
}

function isContributionActionSurface(value: unknown): value is ContributionActionSurface {
    return value === 'cli'
        || value === 'mcp'
        || value === 'agent'
        || value === 'ui'
        || value === 'plugin';
}

function isContributionActionDangerLevel(value: unknown): value is ContributionActionDangerLevel {
    return value === 'safe'
        || value === 'writesLocal'
        || value === 'writesRemote'
        || value === 'externalSideEffect'
        || value === 'destructive';
}

type StructuralContributionOperationProjection = Readonly<{
    manifest: ProjectedContributionOperation;
    semantic: TargetedContributionProtocolSemanticOperation;
}>;

function readStructuralContributionOperation(
    value: unknown,
): StructuralContributionOperationProjection | null {
    if (!isSemanticRecord(value)) return null;
    const declaration = value['declaration'];
    if (!isSemanticRecord(declaration)) return null;
    const required = declaration['required'];
    const rawInput = declaration['input'];
    const resultSchemaValue = declaration['resultSchema'];
    const dangerLevel = declaration['dangerLevel'];
    const surfaces = declaration['surfaces'];
    if (typeof required !== 'boolean'
        || !isSemanticRecord(rawInput)
        || !isContributionActionDangerLevel(dangerLevel)
        || !Array.isArray(surfaces)
        || surfaces.length !== 1
        || !isContributionActionSurface(surfaces[0])) {
        return null;
    }

    let input: ProjectedContributionOperation['input'];
    let semanticInput: TargetedContributionProtocolSemanticOperation['input'];
    const inputKind = rawInput['kind'];
    if (inputKind === 'contributorDefined') {
        input = Object.freeze({ kind: 'contributorDefined' as const });
        semanticInput = Object.freeze({ kind: 'contributorDefined' as const });
    } else if (inputKind === 'protocolDefined') {
        let schema: ProtocolComposableSchema<JsonValue, JsonValue>;
        try {
            schema = requireExecutableProtocolSchema(
                rawInput['schema'],
                'Operation input schema',
            );
        } catch {
            return null;
        }
        input = Object.freeze({ kind: 'protocolDefined' as const, schema: schema.jsonSchema });
        semanticInput = Object.freeze({ kind: 'protocolDefined' as const, schema });
    } else {
        return null;
    }

    let resultSchema: ProtocolComposableSchema<JsonValue, JsonValue>;
    try {
        resultSchema = requireExecutableProtocolSchema(resultSchemaValue, 'Operation result schema');
    } catch {
        return null;
    }
    const surface = surfaces[0];
    if (!isContributionActionSurface(surface)) return null;
    const action = Object.freeze({ surface, dangerLevel });
    const manifest: ProjectedContributionOperation = Object.freeze({
        required,
        input,
        resultSchema: resultSchema.jsonSchema,
        action,
    });
    const semantic: TargetedContributionProtocolSemanticOperation = Object.freeze({
        input: semanticInput,
        resultSchema,
    });
    return Object.freeze({ manifest, semantic });
}

type StructuralContributionSurfaceProjection = Readonly<{
    manifest: ProjectedContributionSurface;
    semantic: TargetedContributionProtocolSemanticSurface;
}>;

function readStructuralContributionSurface(
    value: unknown,
): StructuralContributionSurfaceProjection | null {
    if (!isSemanticRecord(value)) return null;
    const required = value['required'];
    const presentation = value['presentation'];
    if (typeof required !== 'boolean'
        || (presentation !== 'content' && presentation !== 'fill')) {
        return null;
    }
    let inputSchema: ProtocolComposableSchema<JsonValue, JsonValue>;
    try {
        inputSchema = requireExecutableProtocolSchema(
            value['inputSchema'],
            'Surface input schema',
        );
    } catch {
        return null;
    }
    return Object.freeze({
        manifest: Object.freeze({
            required,
            inputSchema: inputSchema.jsonSchema,
            presentation,
        }),
        semantic: Object.freeze({ required, presentation }),
    });
}

type StructuralContributionProtocolProjection = Readonly<{
    manifest: ContributionProtocolManifest;
    semantic: TargetedContributionProtocolSemanticFact;
}>;

/**
 * Projects the documented public protocol contract, not SDK-copy helper
 * evidence. An independently installed SDK can therefore contribute the same
 * frozen-or-mutable five-member Protocol values without sharing local symbols.
 */
function readStructuralContributionProtocol(
    value: unknown,
): StructuralContributionProtocolProjection | null {
    const protocol = readRuntimeProtocolIdentity(value);
    if (!protocol || !isSemanticRecord(value)) return null;
    const rawOperations = value['operations'];
    const rawSurfaces = value['surfaces'];
    if (!isSemanticRecord(rawOperations) || !isSemanticRecord(rawSurfaces)) return null;

    const manifestOperations: Record<string, ProjectedContributionOperation> = {};
    const semanticOperations: Record<string, TargetedContributionProtocolSemanticOperation> = {};
    for (const [role, operation] of Object.entries(rawOperations)) {
        if (!PluginContributionOperationRoleV1Schema.safeParse(role).success) return null;
        const projection = readStructuralContributionOperation(operation);
        if (!projection) return null;
        manifestOperations[role] = projection.manifest;
        semanticOperations[role] = projection.semantic;
    }

    const manifestSurfaces: Record<string, ProjectedContributionSurface> = {};
    const semanticSurfaces: Record<string, TargetedContributionProtocolSemanticSurface> = {};
    for (const [role, surface] of Object.entries(rawSurfaces)) {
        if (!PluginContributionLocalIdSchema.safeParse(role).success) return null;
        const projection = readStructuralContributionSurface(surface);
        if (!projection) return null;
        manifestSurfaces[role] = projection.manifest;
        semanticSurfaces[role] = projection.semantic;
    }

    const descriptorValue = value['descriptor'];
    let descriptor: ProtocolComposableSchema<JsonValue, JsonValue> | undefined;
    if (descriptorValue !== undefined) {
        try {
            descriptor = requireExecutableProtocolSchema(
                descriptorValue,
                'Contribution descriptor schema',
            );
        } catch {
            return null;
        }
    }
    const manifest: ContributionProtocolManifest = Object.freeze({
        ...protocol,
        ...(descriptor === undefined ? {} : { descriptor: descriptor.jsonSchema }),
        operations: Object.freeze(manifestOperations),
        ...(Object.keys(manifestSurfaces).length === 0
            ? {}
            : { surfaces: Object.freeze(manifestSurfaces) }),
    });
    const semantic: TargetedContributionProtocolSemanticFact = Object.freeze({
        protocol,
        ...(descriptor === undefined ? {} : { descriptor }),
        operations: Object.freeze(semanticOperations),
        surfaces: Object.freeze(semanticSurfaces),
    });
    return Object.freeze({ manifest, semantic });
}

function readTargetedContributionProtocolSemanticFact(
    value: unknown,
): TargetedContributionProtocolSemanticFact | null {
    if (!isSemanticRecord(value)) return null;
    const protocol = readRuntimeProtocolIdentity(value['protocol']);
    const operations = readRuntimeSemanticOperations(value['operations']);
    const surfaces = readRuntimeSemanticSurfaces(value['surfaces']);
    if (!protocol || !operations || !surfaces) return null;
    const descriptorValue = value['descriptor'];
    let descriptor: ProtocolComposableSchema<JsonValue, JsonValue> | undefined;
    if (descriptorValue !== undefined) {
        try {
            descriptor = requireExecutableProtocolSchema(
                descriptorValue,
                'Contribution descriptor schema',
            );
        } catch {
            return null;
        }
    }
    return Object.freeze({
        protocol,
        ...(descriptor === undefined ? {} : { descriptor }),
        operations,
        surfaces,
    });
}

function createTargetedContributionPointSemanticCarrier(
    targetPluginId: string,
    pointId: string,
    fact: TargetedContributionProtocolSemanticFact,
): TargetedContributionPointSemanticCarrier {
    return Object.freeze({
        kind: TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_KIND,
        version: TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_VERSION,
        targetPluginId,
        id: pointId,
        protocol: fact.protocol,
        ...(fact.descriptor === undefined ? {} : { descriptor: fact.descriptor }),
        operations: fact.operations,
        surfaces: fact.surfaces,
    });
}

function readTargetedContributionPointSemanticCarrier(
    value: unknown,
): TargetedContributionPointSemanticCarrier | null {
    if (!isSemanticRecord(value)) return null;
    const kind = value['kind'];
    const version = value['version'];
    const targetPluginId = value['targetPluginId'];
    const id = value['id'];
    const protocol = readRuntimeProtocolIdentity(value['protocol']);
    const operations = readRuntimeSemanticOperations(value['operations']);
    const surfaces = readRuntimeSemanticSurfaces(value['surfaces']);
    if (kind !== TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_KIND
        || version !== TARGETED_CONTRIBUTION_POINT_SEMANTIC_CARRIER_VERSION
        || typeof targetPluginId !== 'string'
        || typeof id !== 'string'
        || !PluginIdSchema.safeParse(targetPluginId).success
        || !PluginContributionLocalIdSchema.safeParse(id).success
        || !protocol
        || !operations
        || !surfaces) {
        return null;
    }

    const descriptorValue = value['descriptor'];
    let descriptor: ProtocolComposableSchema<JsonValue, JsonValue> | undefined;
    if (descriptorValue !== undefined) {
        try {
            descriptor = requireExecutableProtocolSchema(
                descriptorValue,
                'Contribution descriptor schema',
            );
        } catch {
            return null;
        }
    }

    return Object.freeze({
        kind,
        version,
        targetPluginId,
        id,
        protocol,
        ...(descriptor === undefined ? {} : { descriptor }),
        operations,
        surfaces,
    });
}

function readContributionPointSemanticFacts(
    point: ContributionPointAuthorDefinition,
): readonly TargetedContributionProtocolSemanticFact[] {
    const carrier = (point as ContributionPointDefinitionWithSemanticCarrier).semanticCarrier;
    if (!Array.isArray(carrier) || carrier.length !== point.protocols.length) {
        throw new TypeError('Contribution point helper semantics are invalid');
    }
    const facts: TargetedContributionProtocolSemanticFact[] = [];
    for (const [index, value] of carrier.entries()) {
        const fact = readTargetedContributionProtocolSemanticFact(value);
        const manifest = point.protocols[index];
        if (!fact || !manifest || !sameProtocolIdentity(fact.protocol, manifest)) {
            throw new TypeError('Contribution point helper semantics are invalid');
        }
        facts.push(fact);
    }
    return Object.freeze(facts);
}

function createDefinedTargetedContributionPointRef(
    targetPluginId: string,
    pointId: string,
    protocol: ContributionProtocolManifest,
    fact: TargetedContributionProtocolSemanticFact,
): TargetedContributionPointRef {
    if (!sameProtocolIdentity(fact.protocol, protocol)) {
        throw new TypeError('Contribution point helper semantics are invalid');
    }
    const point = {
        targetPluginId,
        id: pointId,
        protocol: Object.freeze({ id: protocol.id, version: protocol.version }),
        semanticCarrier: createTargetedContributionPointSemanticCarrier(targetPluginId, pointId, fact),
    };
    return Object.freeze(point);
}

function createContributionPointDefinition<TProtocols extends readonly unknown[]>(
    protocols: readonly ContributionProtocolManifest[],
    options: ContributionPointOptions,
    semanticProtocols: readonly TargetedContributionProtocolSemanticFact[],
): ContributionPointDefinitionWithSemanticCarrier<TProtocols> {
    if (semanticProtocols.length !== protocols.length) {
        throw new TypeError('Contribution point helper semantics are invalid');
    }
    const definition = {
        ...(options.maxContributionsPerContributor === undefined
            ? {}
            : { maxContributionsPerContributor: options.maxContributionsPerContributor }),
        protocols: Object.freeze(protocols.map((protocol) => Object.freeze({ ...protocol }))),
    };
    // This named structural carrier remains available to the target-point
    // projector, but stays outside the canonical JSON manifest projection.
    Object.defineProperty(definition, 'semanticCarrier', {
        value: Object.freeze([...semanticProtocols]),
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return Object.freeze(definition) as unknown as ContributionPointDefinitionWithSemanticCarrier<TProtocols>;
}

function assertContributionOperationRoles(operations: Readonly<Record<string, unknown>>): void {
    for (const role of Object.keys(operations)) {
        PluginContributionOperationRoleV1Schema.parse(role);
    }
}

function assertContributionSurfaceRoles(surfaces: Readonly<Record<string, unknown>>): void {
    for (const role of Object.keys(surfaces)) {
        PluginContributionLocalIdSchema.parse(role);
    }
}

/** The public structural protocol fields needed to combine target epochs. */
export type ContributionProtocolForPoint = Readonly<{
    id: string;
    version: number;
    descriptor?: unknown;
    operations: object;
    surfaces: object;
}>;

/** Combines the bounded protocol epochs accepted by one target-owned point. */
export function defineContributionPoint<
    const TProtocols extends readonly [
        ContributionProtocolForPoint,
        ...ContributionProtocolForPoint[],
    ],
>(
    protocols: TProtocols,
    options: ContributionPointOptions = {},
): ContributionPointAuthorDefinition<TProtocols> {
    if (protocols.length === 0) {
        throw new TypeError('A contribution point requires at least one protocol epoch');
    }
    if (protocols.length > 4) {
        throw new TypeError('A contribution point allows at most four protocol epochs');
    }
    const identities = new Set<string>();
    const semanticProtocols: TargetedContributionProtocolSemanticFact[] = [];
    const manifestProtocols = protocols.map((protocol) => {
        const projection = readStructuralContributionProtocol(protocol);
        if (!projection) throw new TypeError('Contribution protocol contract is invalid');
        const identity = JSON.stringify([projection.manifest.id, projection.manifest.version]);
        if (identities.has(identity)) {
            throw new TypeError('Duplicate contribution protocol identity');
        }
        identities.add(identity);
        semanticProtocols.push(projection.semantic);
        return projection.manifest;
    });
    return createContributionPointDefinition<TProtocols>(manifestProtocols, options, semanticProtocols);
}

/**
 * Projects typed target point refs after `definePlugin` has assigned actual
 * local point IDs. `targeted` is retained here because this is host-routing
 * projection, not a public authoring constructor.
 */
export function projectDefinedTargetedContributionPoints<
    TPluginId extends string,
    TPoints extends Readonly<Record<string, ContributionPointAuthorDefinition>>,
>(
    _pluginId: TPluginId,
    points: TPoints | undefined,
): DefinedContributionPoints<TPluginId, DefinedContributionPointProtocolMap<TPoints>> {
    const entries = Object.entries(points ?? {}).map(([pointId, point]) => {
        const semanticFacts = readContributionPointSemanticFacts(point);
        const protocolRefs = point.protocols.map((protocol, index) => {
            const semantic = semanticFacts[index];
            if (!semantic) throw new TypeError('Contribution point helper semantics are invalid');
            return createDefinedTargetedContributionPointRef(_pluginId, pointId, protocol, semantic);
        });
        if (protocolRefs.length === 0) {
            throw new TypeError(`Contribution point '${pointId}' has no protocol`);
        }
        const projectedPoint = protocolRefs.length === 1
            ? protocolRefs[0]
            : Object.freeze({ protocols: Object.freeze(protocolRefs) });
        return [pointId, projectedPoint] as const;
    });
    return Object.freeze(Object.fromEntries(entries)) as unknown as DefinedContributionPoints<
        TPluginId,
        DefinedContributionPointProtocolMap<TPoints>
    >;
}

/**
 * Retains exact target point refs alongside the parsed contribution-point
 * collection. The named property is non-enumerable because executable target
 * schemas are host-only rather than canonical manifest JSON.
 */
export function attachTargetedContributionPointSemanticRefs(
    contributionPoints: object,
    refs: readonly TargetedContributionPointRef<unknown>[],
): void {
    Object.defineProperty(contributionPoints, TARGETED_CONTRIBUTION_SEMANTIC_REFS_FIELD, {
        value: Object.freeze([...refs]),
        enumerable: false,
        configurable: false,
        writable: false,
    });
}

/**
 * @realm daemon
 *
 * Reads only the exact refs retained by `definePlugin`; canonical JSON cannot
 * supply executable target semantics. The cold registry still validates each
 * carrier through the target-authored semantic decoder before using it.
 */
export function readTargetedContributionPointSemanticRefs(
    manifest: unknown,
): readonly TargetedContributionPointRef<unknown>[] {
    if (!isSemanticRecord(manifest)) return Object.freeze([]);
    const contributes = manifest['contributes'];
    if (!isSemanticRecord(contributes)) return Object.freeze([]);
    const contributionPoints = contributes['pluginContributionPoints'];
    if (contributionPoints === null
        || (typeof contributionPoints !== 'object' && typeof contributionPoints !== 'function')) {
        return Object.freeze([]);
    }
    const refs = (contributionPoints as Readonly<Record<string, unknown>>)[
        TARGETED_CONTRIBUTION_SEMANTIC_REFS_FIELD
    ];
    return Array.isArray(refs)
        ? refs as readonly TargetedContributionPointRef<unknown>[]
        : Object.freeze([]);
}

function readInputOperationRole(value: unknown): Readonly<{
    role: string;
}> | null {
    if (!isSemanticRecord(value)) return null;
    const role = value['role'];
    if (typeof role !== 'string') return null;
    return Object.freeze({ role });
}

function readInputSurfaceRole(value: unknown): Readonly<{
    role: string;
    presentation: unknown;
}> | null {
    if (!isSemanticRecord(value)) return null;
    const role = value['role'];
    if (typeof role !== 'string') return null;
    return Object.freeze({ role, presentation: value['presentation'] });
}

type TargetedContributionPointSemanticFailureCode =
    | 'target_semantics_unavailable'
    | 'descriptor_semantic_invalid'
    | 'surface_semantic_invalid'
    | 'point_reference_invalid';

type TargetedContributionPointSemanticDecodeResult<TContribution> = Readonly<
    | {
        ok: true;
        projection: TargetedContributionPointSemanticProjection<TContribution>;
    }
    | {
        ok: false;
        code: TargetedContributionPointSemanticFailureCode;
    }
>;

function semanticFailure<TCode extends TargetedContributionPointSemanticFailureCode>(
    code: TCode,
): Readonly<{ ok: false; code: TCode }> {
    return Object.freeze({ ok: false, code });
}

function readPointSemanticCarrier(
    point: TargetedContributionPointRef<unknown>,
): Readonly<
    | { ok: true; carrier: TargetedContributionPointSemanticCarrier }
    | { ok: false; code: 'target_semantics_unavailable' }
> {
    if (!isSemanticRecord(point)) return semanticFailure('target_semantics_unavailable');
    const carrier = readTargetedContributionPointSemanticCarrier(
        point.semanticCarrier,
    );
    if (!carrier) return semanticFailure('target_semantics_unavailable');
    const pointProtocol = readRuntimeProtocolIdentity(point['protocol']);
    const targetPluginId = point['targetPluginId'];
    const pointId = point['id'];
    if (!pointProtocol
        || typeof targetPluginId !== 'string'
        || typeof pointId !== 'string'
        || !sameProtocolIdentity(carrier.protocol, pointProtocol)
        || carrier.targetPluginId !== targetPluginId
        || carrier.id !== pointId) {
        return semanticFailure('target_semantics_unavailable');
    }
    return Object.freeze({ ok: true, carrier });
}

/**
 * @realm daemon
 *
 * Replays only the executable semantic facts that the target itself authored
 * for an already-admitted contribution. The cold manifest parser and CLI
 * registry remain the authoritative admission owners; this rejects corrupted
 * snapshots without creating a second manifest reader or descriptor registry.
 */
export function decodeTargetedContributionPointSemantics<TContribution>(
    point: TargetedContributionPointRef<TContribution>,
    input: TargetedContributionPointSemanticInput,
): TargetedContributionPointSemanticDecodeResult<TContribution> {
    const carrierResult = readPointSemanticCarrier(point);
    if (!carrierResult.ok) return carrierResult;
    const carrier = carrierResult.carrier;
    const inputProtocol = readRuntimeProtocolIdentity(input.protocol);
    if (!inputProtocol || !sameProtocolIdentity(carrier.protocol, inputProtocol)) {
        return semanticFailure('point_reference_invalid');
    }
    if (!Array.isArray(input.operations) || !Array.isArray(input.surfaces)) {
        return semanticFailure('target_semantics_unavailable');
    }

    const operationRoles = new Set<string>();
    for (const operation of input.operations) {
        const candidate = readInputOperationRole(operation);
        if (!candidate
            || !PluginContributionOperationRoleV1Schema.safeParse(candidate.role).success
            || operationRoles.has(candidate.role)
            || !carrier.operations[candidate.role]) {
            return semanticFailure('target_semantics_unavailable');
        }
        operationRoles.add(candidate.role);
    }
    if (Object.keys(carrier.operations).some((role) => !operationRoles.has(role))) {
        return semanticFailure('target_semantics_unavailable');
    }
    const operations = Object.freeze([...operationRoles].sort().map((role) => {
        const operation = carrier.operations[role];
        if (!operation) throw new TypeError('Target operation semantics are unavailable');
        return Object.freeze({
            role,
            input: operation.input,
            resultSchema: operation.resultSchema,
        });
    }));

    let descriptor: JsonValue | undefined;
    if (input.descriptor !== undefined) {
        if (!carrier.descriptor) return semanticFailure('descriptor_semantic_invalid');
        let parsed: ReturnType<ProtocolComposableSchema<JsonValue, JsonValue>['safeParse']>;
        try {
            parsed = carrier.descriptor.safeParse(input.descriptor);
        } catch {
            return semanticFailure('descriptor_semantic_invalid');
        }
        if (!parsed.success) return semanticFailure('descriptor_semantic_invalid');
        descriptor = parsed.data;
    }

    const presentRoles = new Set<string>();
    for (const surface of input.surfaces) {
        const candidate = readInputSurfaceRole(surface);
        if (!candidate) return semanticFailure('surface_semantic_invalid');
        const requirement = carrier.surfaces[candidate.role];
        // A future optional role has no authority in an older target. In
        // particular, do not validate its presentation before ignoring it.
        if (!requirement) continue;
        if (presentRoles.has(candidate.role)
            || candidate.presentation !== requirement.presentation) {
            return semanticFailure('surface_semantic_invalid');
        }
        presentRoles.add(candidate.role);
    }

    const surfaces: TargetedContributionPointSemanticSurface[] = [];
    for (const role of Object.keys(carrier.surfaces).sort()) {
        const requirement = carrier.surfaces[role];
        if (!requirement) return semanticFailure('target_semantics_unavailable');
        if (requirement.required && !presentRoles.has(role)) {
            return semanticFailure('surface_semantic_invalid');
        }
        if (!presentRoles.has(role)) continue;
        surfaces.push(Object.freeze({ role, presentation: requirement.presentation }));
    }

    return Object.freeze({
        ok: true,
        projection: Object.freeze({
            ...(descriptor === undefined ? {} : { descriptor }),
            operations,
            surfaces: Object.freeze(surfaces),
        }) as TargetedContributionPointSemanticProjection<TContribution>,
    });
}

/**
 * Declares one target-owned cross-plugin protocol and its cold manifest
 * projection. Parser methods remain in-process; only `jsonSchema` is written
 * into the manifest.
 */
export function defineContributionProtocol<
    const TOperations extends Readonly<Record<string, ContributionOperationDefinition>>,
    const TSurfaces extends Readonly<Record<string, ContributionSurfaceDefinition>> = Readonly<Record<string, never>>,
    const TDescriptorSchema extends ProtocolComposableSchema<JsonValue, JsonValue> | undefined = undefined,
    const TProtocolId extends string = string,
    const TProtocolVersion extends number = number,
>(
    definition: ContributionProtocolDefinition<
        TOperations,
        TSurfaces,
        TDescriptorSchema,
        TProtocolId,
        TProtocolVersion
    >,
): ContributionProtocol<TOperations, TSurfaces, TDescriptorSchema, TProtocolId, TProtocolVersion> {
    const id = PluginContributionProtocolIdV1Schema.parse(definition.id);
    assertContributionOperationRoles(definition.operations);
    assertContributionSurfaceRoles(definition.surfaces ?? {});
    const projectedOperations = Object.freeze(Object.fromEntries(
        Object.entries(definition.operations).map(([role, operation]) => [
            role,
            projectOperation(operation),
        ]),
    )) as Readonly<Record<string, ProjectedContributionOperation>>;
    const projectedSurfaces = definition.surfaces === undefined
        ? undefined
        : Object.freeze(Object.fromEntries(Object.entries(definition.surfaces).map(([role, surface]) => [
            role,
            projectSurface(surface),
        ]))) as Readonly<Record<string, ProjectedContributionSurface>>;
    const descriptorSchema = definition.descriptor === undefined
        ? undefined
        : requireExecutableProtocolSchema(definition.descriptor, 'Descriptor schema');
    const semanticOperations = Object.freeze(Object.fromEntries(
        Object.entries(definition.operations).map(([role, operation]) => [
            role,
            resolveTargetedContributionOperationSemantics(operation),
        ]),
    )) as Readonly<Record<string, TargetedContributionProtocolSemanticOperation>>;
    const operations = Object.freeze(Object.fromEntries(
        Object.entries(definition.operations).map(([role, operation]) => {
            const semantics = semanticOperations[role];
            if (!semantics) throw new TypeError('Contribution protocol helper semantics are invalid');
            const declaration = Object.freeze({
                required: operation.required,
                input: semantics.input,
                resultSchema: semantics.resultSchema,
                dangerLevel: operation.action.dangerLevel,
                surfaces: Object.freeze([operation.action.surface]),
            });
            return [role, Object.freeze({
                declaration,
                bind<TActionLocalId extends string>(actionLocalId: TActionLocalId): TActionLocalId {
                    return actionLocalId;
                },
            })];
        }),
    )) as ContributionProtocol<
        TOperations,
        TSurfaces,
        TDescriptorSchema,
        TProtocolId,
        TProtocolVersion
    >['operations'];
    const surfaces = Object.freeze(Object.fromEntries(
        Object.entries(definition.surfaces ?? {}).map(([role, surface]) => [role, Object.freeze({
            required: surface.required,
            inputSchema: requireExecutableProtocolSchema(surface.inputSchema, 'Surface input schema'),
            presentation: surface.presentation,
            node(input: ContributionSurfaceNodeInput): ContributionSurfaceNode {
                return createTargetedSurfaceNode({
                    pointId: input.pointId,
                    protocol,
                    contributor: input.contributor,
                    role,
                    // The role's executable reader remains the sole early input
                    // validator; symbolic wrapper admission stays with definePlugin.
                    value: surface.inputSchema.parse(input.input),
                    instanceKey: input.instanceKey,
                    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
                });
            },
        })]),
    )) as ContributionProtocol<
        TOperations,
        TSurfaces,
        TDescriptorSchema,
        TProtocolId,
        TProtocolVersion
    >['surfaces'];
    const protocol = Object.freeze({ id, version: definition.version });
    const semanticSurfaces = Object.freeze(Object.fromEntries(
        Object.entries(definition.surfaces ?? {}).map(([role, surface]) => [role, Object.freeze({
            required: surface.required,
            presentation: surface.presentation,
        })]),
    )) as Readonly<Record<string, TargetedContributionProtocolSemanticSurface>>;
    const semanticFact: TargetedContributionProtocolSemanticFact = Object.freeze({
        protocol,
        ...(descriptorSchema === undefined ? {} : { descriptor: descriptorSchema }),
        operations: semanticOperations,
        surfaces: semanticSurfaces,
    });
    const projectedProtocol: ContributionProtocolManifest = Object.freeze({
        ...protocol,
        ...(descriptorSchema === undefined ? {} : { descriptor: descriptorSchema.jsonSchema }),
        operations: projectedOperations,
        ...(projectedSurfaces === undefined ? {} : { surfaces: projectedSurfaces }),
    });
    return Object.freeze({
        ...protocol,
        ...(descriptorSchema === undefined ? {} : { descriptor: descriptorSchema }),
        operations,
        surfaces,
        point(options: ContributionPointOptions = {}) {
            return createContributionPointDefinition<
                readonly [ContributionProtocol<
                    TOperations,
                    TSurfaces,
                    TDescriptorSchema,
                    TProtocolId,
                    TProtocolVersion
                >]
            >([projectedProtocol], options, [semanticFact]);
        },
        contribute<TActionLocalId extends string, TRendererLocalId extends string>(
            input: ContributionContributeInput<
                TOperations,
                TSurfaces,
                TDescriptorSchema,
                TActionLocalId,
                TRendererLocalId
            >,
        ): ContributionAuthorDefinition<
            TActionLocalId,
            TRendererLocalId,
            TOperations,
            TSurfaces,
            TDescriptorSchema
        > {
            assertContributionOperationRoles(input.operations);
            assertContributionSurfaceRoles(input.surfaces ?? {});
            const rawInput = input as Readonly<{
                descriptor?: JsonValue;
                surfaces?: Readonly<Record<string, ContributionSurfaceBinding>>;
            }>;
            if (rawInput.descriptor !== undefined && descriptorSchema === undefined) {
                throw new TypeError('Contribution protocol does not declare a descriptor schema');
            }
            if (rawInput.descriptor === undefined && descriptorSchema !== undefined) {
                throw new TypeError('Contribution protocol requires a descriptor');
            }
            const descriptor = rawInput.descriptor === undefined
                ? undefined
                : descriptorSchema?.parse(rawInput.descriptor);
            const surfaceBindings = projectSurfaceBindings(rawInput.surfaces);
            return Object.freeze({
                protocol,
                ...(descriptor === undefined ? {} : { descriptor }),
                operations: Object.freeze({ ...input.operations }),
                ...(surfaceBindings === undefined ? {} : { surfaces: surfaceBindings }),
            }) as unknown as ContributionAuthorDefinition<
                TActionLocalId,
                TRendererLocalId,
                TOperations,
                TSurfaces,
                TDescriptorSchema
            >;
        },
    }) as unknown as ContributionProtocol<
        TOperations,
        TSurfaces,
        TDescriptorSchema,
        TProtocolId,
        TProtocolVersion
    >;
}
