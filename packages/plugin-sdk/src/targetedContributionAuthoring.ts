import {
    PluginContributionLocalIdSchema,
    PluginContributionOperationRoleV1Schema,
    PluginContributionProtocolIdV1Schema,
} from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginContributionPointProtocolV1Schema } from '@happier-dev/protocol/plugins/contributions/targeted';
import { cloneStrictPluginJsonValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1,
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

/** A helper-produced target declaration whose protocol tuple preserves exact author inference. */
export type ContributionPointAuthorDefinition<
    TProtocols extends readonly unknown[],
> = Readonly<{
    maxContributionsPerContributor?: number;
    protocols: readonly ContributionProtocolManifest[];
    readonly __protocols?: TProtocols;
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
    TPoints extends Readonly<Record<string, ContributionPointAuthorDefinition<readonly unknown[]>>>,
> = Readonly<{
    [TPointId in keyof TPoints & string]: TPoints[TPointId] extends ContributionPointAuthorDefinition<
        infer TProtocols extends readonly unknown[]
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

function readStructuralContributionOperation(
    value: unknown,
): ProjectedContributionOperation | null {
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
    const inputKind = rawInput['kind'];
    if (inputKind === 'contributorDefined') {
        input = Object.freeze({ kind: 'contributorDefined' as const });
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
    return Object.freeze({
        required,
        input,
        resultSchema: resultSchema.jsonSchema,
        action,
    });
}

function readStructuralContributionSurface(
    value: unknown,
): ProjectedContributionSurface | null {
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
        required,
        inputSchema: inputSchema.jsonSchema,
        presentation,
    });
}

/**
 * Projects the documented public protocol contract, not SDK-copy helper
 * evidence. An independently installed SDK can therefore contribute the same
 * frozen-or-mutable five-member Protocol values without sharing local symbols.
 */
function readStructuralContributionProtocol(
    value: unknown,
): ContributionProtocolManifest | null {
    const canonicalManifest = PluginContributionPointProtocolV1Schema.safeParse(value);
    if (canonicalManifest.success) {
        return canonicalManifest.data as ContributionProtocolManifest;
    }
    const protocol = readRuntimeProtocolIdentity(value);
    if (!protocol || !isSemanticRecord(value)) return null;
    const rawOperations = value['operations'];
    const rawSurfaces = value['surfaces'];
    if (!isSemanticRecord(rawOperations)
        || (rawSurfaces !== undefined && !isSemanticRecord(rawSurfaces))) {
        return null;
    }

    const manifestOperations: Record<string, ProjectedContributionOperation> = {};
    for (const [role, operation] of Object.entries(rawOperations)) {
        if (!PluginContributionOperationRoleV1Schema.safeParse(role).success) return null;
        const projection = readStructuralContributionOperation(operation);
        if (!projection) return null;
        manifestOperations[role] = projection;
    }

    const manifestSurfaces: Record<string, ProjectedContributionSurface> = {};
    for (const [role, surface] of Object.entries(rawSurfaces ?? {})) {
        if (!PluginContributionLocalIdSchema.safeParse(role).success) return null;
        const projection = readStructuralContributionSurface(surface);
        if (!projection) return null;
        manifestSurfaces[role] = projection;
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
    const manifest = Object.freeze({
        ...protocol,
        ...(descriptor === undefined ? {} : { descriptor: descriptor.jsonSchema }),
        operations: Object.freeze(manifestOperations),
        ...(Object.keys(manifestSurfaces).length === 0
            ? {}
            : { surfaces: Object.freeze(manifestSurfaces) }),
    });
    const admittedManifest = PluginContributionPointProtocolV1Schema.safeParse(manifest);
    if (!admittedManifest.success) return null;
    return admittedManifest.data as ContributionProtocolManifest;
}

function createDefinedTargetedContributionPointRef(
    targetPluginId: string,
    pointId: string,
    protocol: ContributionProtocolManifest,
): TargetedContributionPointRef {
    return Object.freeze({
        targetPluginId,
        id: pointId,
        protocol: Object.freeze({ id: protocol.id, version: protocol.version }),
    });
}

function createContributionPointDefinition<TProtocols extends readonly unknown[]>(
    protocols: readonly ContributionProtocolManifest[],
    options: ContributionPointOptions,
): ContributionPointAuthorDefinition<TProtocols> {
    return Object.freeze({
        ...(options.maxContributionsPerContributor === undefined
            ? {}
            : { maxContributionsPerContributor: options.maxContributionsPerContributor }),
        protocols: Object.freeze(protocols.map((protocol) => Object.freeze({ ...protocol }))),
    }) as ContributionPointAuthorDefinition<TProtocols>;
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
    surfaces?: object;
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
    if (protocols.length > PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1) {
        throw new TypeError('A contribution point allows at most four protocol epochs');
    }
    const identities = new Set<string>();
    const manifestProtocols = protocols.map((protocol) => {
        const manifest = readStructuralContributionProtocol(protocol);
        if (!manifest) throw new TypeError('Contribution protocol contract is invalid');
        const identity = JSON.stringify([manifest.id, manifest.version]);
        if (identities.has(identity)) {
            throw new TypeError('Duplicate contribution protocol identity');
        }
        identities.add(identity);
        return manifest;
    });
    return createContributionPointDefinition<TProtocols>(manifestProtocols, options);
}

/**
 * Projects typed target point refs after `definePlugin` has assigned actual
 * local point IDs. `targeted` is retained here because this is host-routing
 * projection, not a public authoring constructor.
 */
export function projectDefinedTargetedContributionPoints<
    TPluginId extends string,
    TPoints extends Readonly<Record<string, ContributionPointAuthorDefinition<readonly unknown[]>>>,
>(
    _pluginId: TPluginId,
    points: TPoints | undefined,
): DefinedContributionPoints<TPluginId, DefinedContributionPointProtocolMap<TPoints>> {
    const entries = Object.entries(points ?? {}).map(([pointId, point]) => {
        const protocolRefs = point.protocols.map((protocol) => (
            createDefinedTargetedContributionPointRef(_pluginId, pointId, protocol)
        ));
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
    const operations = Object.freeze(Object.fromEntries(
        Object.entries(definition.operations).map(([role, operation]) => {
            const input = operation.input.kind === 'contributorDefined'
                ? Object.freeze({ kind: 'contributorDefined' as const })
                : Object.freeze({
                    kind: 'protocolDefined' as const,
                    schema: requireExecutableProtocolSchema(operation.input.schema, 'Operation input schema'),
                });
            const declaration = Object.freeze({
                required: operation.required,
                input,
                resultSchema: requireExecutableProtocolSchema(operation.resultSchema, 'Operation result schema'),
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
            >([projectedProtocol], options);
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
