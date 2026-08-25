import {
    compilePluginJsonSchema,
    PluginDeclarativeDocumentNormalizationErrorV1,
    PluginIdSchema,
    PluginUiRendererV2Schema,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    isValidPluginJsonSchemaValue,
    normalizePluginDeclarativeDocumentV1,
    type PluginContributionIdentityV1,
    type PluginDeclarativeActionVariantV2,
    type PluginDeclarativeComposerApplyEffectV1,
    type PluginDeclarativeCollectionRowCommandV1,
    type PluginDeclarativeCollectionListProjectionV1,
    type PluginDeclarativeControlV2,
    type PluginDeclarativeMetadataEntryV2,
    type PluginDeclarativeNormalizedNodeV1,
    type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
    type PluginDeclarativeStateV2,
    type PluginDeclarativeToneV2,
    type PluginJsonValueV2,
    type PluginLocalizedStringV2,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
    type PluginUiIconTokenV1,
    type PluginUiRendererV2,
    type PluginUiTargetedContributionSurfaceV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { clonePluginPlainData } from '../../plainData';
import {
    type StablePluginSettingsField,
    type StablePluginSettingsModel,
} from './settings';
import {
    HostStructuredMessageDescriptorV1Schema,
    MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1,
    type HostStructuredMessageDescriptorV1,
} from './structuredMessageDescriptor';

const MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_FALLBACK_TEMPLATE_BYTES = 4 * 1024;
const MAX_GENERATION_LENGTH = 256;
const textEncoder = new TextEncoder();

type PluginContributionReference = NonNullable<HostStructuredMessageDescriptorV1['actions']>[number];

/**
 * The declarative SOURCE vocabulary is owned by Protocol and imported, never
 * redeclared. It used to be hand-copied here because
 * `PluginDeclarativeNodeV2Schema` was annotated `z.ZodType<unknown>`: the
 * vocabulary did not survive the package boundary, so adding a node kind in
 * Protocol compiled cleanly through this file and the surfaces below it. This
 * file now owns only the PROJECTED additions — qualified identity, document
 * path, evaluation order, enabled state and the resolved settings field.
 */
type DeclarativeSourceRenderer = Extract<PluginUiRendererV2, { kind: 'declarative' }>;

/** Bound to the protocol declarative vocabulary — never redeclared locally. */
export type StablePluginDeclarativeTone = PluginDeclarativeToneV2;
export type StablePluginDeclarativeActionVariant = PluginDeclarativeActionVariantV2;
export type StablePluginDeclarativeState = PluginDeclarativeStateV2;
export type StablePluginDeclarativeIcon = PluginUiIconTokenV1;

export type StablePluginDeclarativeMetadataEntry = PluginDeclarativeMetadataEntryV2;

export type StablePluginQualifiedReference = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
    generation: string;
}>;

type StablePluginDeclarativeNodeBase = Readonly<{
    path: string;
    order: number;
}>;

export type StablePluginDeclarativeStateNode =
    StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'state';
        state: StablePluginDeclarativeState;
        title: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        icon?: StablePluginDeclarativeIcon;
    }>;

export type StablePluginDeclarativeTargetedSurfaceNode =
    StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'targetedSurface';
        /** Exact protocol-normalized current handle; authors never supply this form. */
        surface: PluginUiTargetedContributionSurfaceV1;
        input: PluginJsonValueV2;
        instanceKey: string;
        fallback?: StablePluginDeclarativeStateNode;
    }>;

export type StablePluginDeclarativeActionNode =
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'action';
        action: StablePluginQualifiedReference;
        label: PluginLocalizedStringV2;
        variant?: StablePluginDeclarativeActionVariant;
        input?: JsonValue;
        enabled: boolean;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'action';
        effect: PluginDeclarativeComposerApplyEffectV1;
        label: PluginLocalizedStringV2;
        variant?: StablePluginDeclarativeActionVariant;
        enabled: boolean;
    }>);

export type StablePluginDeclarativeNode =
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'text';
        text: PluginLocalizedStringV2;
        tone?: StablePluginDeclarativeTone;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'markdown';
        text: PluginLocalizedStringV2;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'stack';
        direction?: 'vertical' | 'horizontal';
        gap?: 'small' | 'medium' | 'large';
        children: readonly StablePluginDeclarativeNode[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'group';
        title?: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        children: readonly StablePluginDeclarativeNode[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'field';
        label: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        control: PluginDeclarativeControlV2;
        setting: StablePluginSettingsField;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'status';
        label: PluginLocalizedStringV2;
        value: PluginLocalizedStringV2;
        tone?: StablePluginDeclarativeTone;
    }>)
    | StablePluginDeclarativeActionNode
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'collectionList';
        label?: PluginLocalizedStringV2;
        source: Readonly<{
            collectionId: string;
            uiQueryId: string;
            parameters: PluginCollectionUiQueryRequestV1['parameters'];
        }>;
        /** Exact Data-normalized descriptor; never reconstructed from a manifest. */
        query: NormalizedPluginCollectionUiQueryDescriptorV1;
        projection: PluginDeclarativeCollectionListProjectionV1;
        /** Fixed references only; the host supplies the row invocation context. */
        primaryCommand?: PluginDeclarativeCollectionRowCommandV1;
        secondaryCommands?: readonly PluginDeclarativeCollectionRowCommandV1[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'list';
        label?: PluginLocalizedStringV2;
        children: readonly StablePluginDeclarativeNode[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'section';
        title?: PluginLocalizedStringV2;
        footer?: PluginLocalizedStringV2;
        children: readonly StablePluginDeclarativeNode[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'item';
        title: PluginLocalizedStringV2;
        subtitle?: PluginLocalizedStringV2;
        detail?: PluginLocalizedStringV2;
        icon?: StablePluginDeclarativeIcon;
        tone?: StablePluginDeclarativeTone;
        /** Present together with `enabled`, or absent — an item row is interactive only when both hold. */
        action?: StablePluginQualifiedReference;
        input?: JsonValue;
        enabled?: boolean;
    }>)
    | StablePluginDeclarativeStateNode
    | StablePluginDeclarativeTargetedSurfaceNode
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'metadata';
        title?: PluginLocalizedStringV2;
        entries: readonly StablePluginDeclarativeMetadataEntry[];
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'actionPanel';
        title?: PluginLocalizedStringV2;
        children: readonly StablePluginDeclarativeNode[];
    }>);

export type StablePluginAvailabilityInput = Readonly<{
    visible: boolean;
    enabledActions: Readonly<Record<string, boolean>>;
}>;

/**
 * The static model's whole admitted inventory. Dynamic documents consume this
 * projection rather than deriving authority from whichever bindings happened
 * to appear in the static first-paint root.
 */
export type StablePluginDeclarativeActionBinding = StablePluginQualifiedReference & Readonly<{
    enabled: boolean;
    /** Current Action-catalog presentation; absent actions cannot become row affordances. */
    title?: string;
    icon?: string;
}>;

export type StablePluginDeclarativeActionPresentation = Readonly<{
    identity: PluginContributionIdentityV1;
    title: string;
    icon?: string;
}>;

export type StablePluginDeclarativeDestinationBinding = StablePluginQualifiedReference;

export type StablePluginDeclarativeSettingsBinding = Readonly<{
    pluginId: string;
    id: string;
    qualifiedId: string;
    schema: unknown;
    secret: boolean;
    /** The exact existing Settings projection reattached by the UI renderer. */
    setting: StablePluginSettingsField;
}>;

export type StablePluginDeclarativeInventory = Readonly<{
    actions: readonly StablePluginDeclarativeActionBinding[];
    /** Declared same-plugin surface destinations admitted for dynamic documents. */
    destinations: readonly StablePluginDeclarativeDestinationBinding[];
    settings: readonly StablePluginDeclarativeSettingsBinding[];
    /** Immutable Data-normalized descriptors admitted for dynamic documents. */
    uiQueries: readonly NormalizedPluginCollectionUiQueryDescriptorV1[];
}>;

export type StablePluginDeclarativeModel = Readonly<{
    identity: Readonly<{
        pluginId: string;
        localId: string;
        qualifiedId: string;
        generation: string;
    }>;
    visible: boolean;
    requiredHostMethods: readonly string[];
    declarativeInventory: StablePluginDeclarativeInventory;
    /**
     * The whole projected document, and the only representation any reader
     * walks. It deliberately has no flat sibling: a parallel `nodes` array held
     * the same node objects, so `JSON.stringify` emitted every container's
     * subtree once more for each of its ancestors.
     */
    root: StablePluginDeclarativeNode;
}>;

export type StablePluginStructuredMessageModel = Readonly<{
    identity: Readonly<{
        pluginId: string;
        localId: string;
        qualifiedId: string;
        generation: string;
    }>;
    kind: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    payload: JsonValue;
    renderer: StablePluginQualifiedReference;
    actions: readonly (StablePluginQualifiedReference & Readonly<{ enabled: boolean }>)[];
    resources: readonly StablePluginQualifiedReference[];
    fallback: HostStructuredMessageDescriptorV1['fallback'];
    visible: boolean;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;

function modelError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function cloneDomainPlainData<T>(
    value: T,
    code: string,
    path: string,
): T {
    return clonePluginPlainData(value, {
        path,
        invalid: (message) => modelError(code, message),
    });
}

function normalizePluginId(pluginId: string): string {
    const parsed = PluginIdSchema.safeParse(pluginId);
    if (!parsed.success) throw modelError('plugin_declarative_identity_invalid', 'Plugin id is invalid');
    return parsed.data;
}

function normalizeGeneration(generation: string): string {
    if (typeof generation !== 'string'
        || generation.trim().length === 0
        || generation.length > MAX_GENERATION_LENGTH) {
        throw modelError('plugin_declarative_generation_invalid', 'Plugin generation is invalid');
    }
    return generation;
}

function qualifiedReference(
    identity: PluginContributionIdentityV1,
    generation: string,
): StablePluginQualifiedReference {
    return Object.freeze({
        identity: Object.freeze({ ...identity }),
        qualifiedId: buildQualifiedPluginContributionKey(identity),
        generation,
    });
}

function normalizeReference(
    ownerPluginId: string,
    reference: PluginContributionReference,
): PluginContributionIdentityV1 {
    return createPluginContributionIdentity(typeof reference === 'string'
        ? { pluginId: ownerPluginId, localId: reference }
        : reference);
}

function buildIdentityInventory(params: Readonly<{
    values: readonly PluginContributionIdentityV1[];
    domain: 'action' | 'destination' | 'resource' | 'renderer';
    invalidPlainDataCode: string;
}>): ReadonlySet<string> {
    const plainValues = cloneDomainPlainData(
        params.values,
        params.invalidPlainDataCode,
        params.domain,
    );
    if (!Array.isArray(plainValues)) {
        throw modelError(`plugin_${params.domain}_identity_invalid`, `${params.domain} identity inventory is invalid`);
    }
    const keys = new Set<string>();
    for (const value of plainValues) {
        let identity: PluginContributionIdentityV1;
        try {
            identity = createPluginContributionIdentity(value);
        } catch {
            throw modelError(`plugin_${params.domain}_identity_invalid`, `${params.domain} identity is invalid`);
        }
        const key = buildQualifiedPluginContributionKey(identity);
        if (keys.has(key)) {
            throw modelError(`plugin_${params.domain}_identity_duplicate`, `Duplicate ${params.domain} '${key}'`);
        }
        keys.add(key);
    }
    return keys;
}

function normalizeAvailability(
    availability: StablePluginAvailabilityInput | undefined,
    actionKeys: ReadonlySet<string>,
    invalidPlainDataCode: string,
): StablePluginAvailabilityInput | undefined {
    if (availability === undefined) return undefined;
    const plain = cloneDomainPlainData(
        availability,
        invalidPlainDataCode,
        'availability',
    );
    if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
        throw modelError('plugin_declarative_availability_invalid', 'Availability input is invalid');
    }
    const keys = Object.keys(plain);
    if (keys.some((key) => key !== 'visible' && key !== 'enabledActions')
        || typeof plain.visible !== 'boolean'
        || !plain.enabledActions
        || typeof plain.enabledActions !== 'object'
        || Array.isArray(plain.enabledActions)) {
        throw modelError('plugin_declarative_availability_invalid', 'Availability input is invalid');
    }
    for (const [key, enabled] of Object.entries(plain.enabledActions)) {
        if (!actionKeys.has(key) || typeof enabled !== 'boolean') {
            throw modelError('plugin_declarative_availability_invalid', `Availability action '${key}' is invalid`);
        }
    }
    return plain;
}

function createStablePluginDeclarativeSettingsInventory(input: Readonly<{
    pluginId: string;
    settings: readonly StablePluginSettingsModel[];
}>): readonly StablePluginDeclarativeSettingsBinding[] {
    const bindings: StablePluginDeclarativeSettingsBinding[] = [];
    for (const model of input.settings) {
        if (model.identity.pluginId !== input.pluginId) {
            throw modelError(
                'plugin_declarative_setting_scope_invalid',
                `Settings model '${model.identity.qualifiedId}' does not belong to '${input.pluginId}'`,
            );
        }
        for (const field of model.fields) {
            bindings.push(Object.freeze({
                pluginId: input.pluginId,
                id: field.id,
                qualifiedId: field.qualifiedId,
                schema: field.descriptor.schema,
                secret: field.descriptor.secret === true,
                setting: field,
            }));
        }
    }
    return Object.freeze(bindings);
}

function createStablePluginDeclarativeActionInventory(input: Readonly<{
    pluginId: string;
    generation: string;
    actions: readonly PluginContributionIdentityV1[];
    presentations: ReadonlyMap<string, Readonly<{ title: string; icon?: string }>>;
    availability?: StablePluginAvailabilityInput;
}>): readonly StablePluginDeclarativeActionBinding[] {
    return Object.freeze(input.actions
        .filter((identity) => identity.pluginId === input.pluginId)
        .map((identity) => {
            const action = qualifiedReference(identity, input.generation);
            const presentation = input.presentations.get(action.qualifiedId);
            return Object.freeze({
                ...action,
                enabled: input.availability?.enabledActions[action.qualifiedId] === true,
                ...(presentation ? presentation : {}),
            });
        }));
}

function createStablePluginDeclarativeActionPresentations(input: Readonly<{
    actions: ReadonlySet<string>;
    presentations: readonly StablePluginDeclarativeActionPresentation[] | undefined;
}>): ReadonlyMap<string, Readonly<{ title: string; icon?: string }>> {
    const byQualifiedId = new Map<string, Readonly<{ title: string; icon?: string }>>();
    for (const presentation of input.presentations ?? []) {
        let identity: PluginContributionIdentityV1;
        try {
            identity = createPluginContributionIdentity(presentation.identity);
        } catch {
            throw modelError('plugin_declarative_action_presentation_invalid', 'Action presentation identity is invalid');
        }
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        const title = typeof presentation.title === 'string' ? presentation.title.trim() : '';
        if (!input.actions.has(qualifiedId) || title.length === 0) {
            throw modelError('plugin_declarative_action_presentation_invalid', 'Action presentation is invalid');
        }
        if (presentation.icon !== undefined && (typeof presentation.icon !== 'string' || presentation.icon.trim().length === 0)) {
            throw modelError('plugin_declarative_action_presentation_invalid', 'Action presentation icon is invalid');
        }
        if (byQualifiedId.has(qualifiedId)) {
            throw modelError('plugin_declarative_action_presentation_invalid', 'Action presentation is duplicated');
        }
        byQualifiedId.set(qualifiedId, Object.freeze({
            title,
            ...(presentation.icon ? { icon: presentation.icon } : {}),
        }));
    }
    return byQualifiedId;
}

function createStablePluginDeclarativeDestinationInventory(input: Readonly<{
    pluginId: string;
    generation: string;
    destinations: readonly PluginContributionIdentityV1[];
}>): readonly StablePluginDeclarativeDestinationBinding[] {
    return Object.freeze(input.destinations
        .filter((identity) => identity.pluginId === input.pluginId)
        .map((identity) => qualifiedReference(identity, input.generation)));
}

export function createStablePluginDeclarativeModel(params: Readonly<{
    pluginId: string;
    generation: string;
    renderer: unknown;
    settings: readonly StablePluginSettingsModel[];
    actions: readonly PluginContributionIdentityV1[];
    /** Current Action catalog labels/icons; row commands never derive them from ids. */
    actionPresentations?: readonly StablePluginDeclarativeActionPresentation[];
    /** Same-plugin surface contributions admitted for fixed row navigation. */
    destinations?: readonly PluginContributionIdentityV1[];
    /** Data's normalized projection, never a manifest declaration. */
    uiQueries?: readonly NormalizedPluginCollectionUiQueryDescriptorV1[];
    /** Exact current prepared target-local surface inventory from the mounted host path. */
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
    availability?: StablePluginAvailabilityInput;
}>): StablePluginDeclarativeModel {
    const pluginId = normalizePluginId(params.pluginId);
    const generation = normalizeGeneration(params.generation);
    const plainRenderer = cloneDomainPlainData(
        params.renderer,
        'plugin_declarative_invalid_plain_data',
        'renderer',
    );
    if (plainRenderer === null || typeof plainRenderer !== 'object' || Array.isArray(plainRenderer)) {
        throw modelError('plugin_declarative_renderer_invalid', 'Declarative renderer is invalid');
    }
    const plainRendererRecord = plainRenderer as Readonly<Record<string, unknown>>;

    // Parse only the static renderer envelope here. Its root goes through the
    // Protocol normalizer below, which is also the sole dynamic-document parser.
    const parsedRenderer = PluginUiRendererV2Schema.safeParse({
        ...plainRendererRecord,
        root: { kind: 'text', text: '_' },
    });
    if (!parsedRenderer.success || parsedRenderer.data.kind !== 'declarative') {
        throw modelError('plugin_declarative_renderer_invalid', 'Declarative renderer is invalid');
    }
    const renderer = parsedRenderer.data as DeclarativeSourceRenderer;
    const actionKeys = buildIdentityInventory({
        values: params.actions,
        domain: 'action',
        invalidPlainDataCode: 'plugin_declarative_invalid_plain_data',
    });
    const availability = normalizeAvailability(
        params.availability,
        actionKeys,
        'plugin_declarative_invalid_plain_data',
    );
    buildIdentityInventory({
        values: params.destinations ?? [],
        domain: 'destination',
        invalidPlainDataCode: 'plugin_declarative_invalid_plain_data',
    });
    const actionPresentations = createStablePluginDeclarativeActionPresentations({
        actions: actionKeys,
        presentations: params.actionPresentations,
    });
    const settingsInventory = createStablePluginDeclarativeSettingsInventory({
        pluginId,
        settings: params.settings,
    });
    // Protocol admits data-only Settings bindings. The richer static projection
    // below also carries the exact UI Settings field for reattachment, but that
    // host-local reference is not part of the neutral normalizer's contract.
    const protocolSettingsInventory = Object.freeze(settingsInventory.map((setting) => Object.freeze({
        pluginId: setting.pluginId,
        id: setting.id,
        qualifiedId: setting.qualifiedId,
        schema: setting.schema,
        secret: setting.secret,
    })));
    const actionsInventory = createStablePluginDeclarativeActionInventory({
        pluginId,
        generation,
        actions: params.actions,
        presentations: actionPresentations,
        availability,
    });
    const destinationsInventory = createStablePluginDeclarativeDestinationInventory({
        pluginId,
        generation,
        destinations: params.destinations ?? [],
    });
    const uiQueriesInventory = Object.freeze([...(params.uiQueries ?? [])]);
    const settingsByQualifiedId = new Map(
        settingsInventory.map((setting) => [setting.qualifiedId, setting]),
    );

    let document: ReturnType<typeof normalizePluginDeclarativeDocumentV1>;
    try {
        document = normalizePluginDeclarativeDocumentV1({
            pluginId,
            generation,
            actions: params.actions,
            destinations: params.destinations ?? [],
            settings: protocolSettingsInventory,
            uiQueries: uiQueriesInventory,
            ...(params.preparedTargetedSurfaces === undefined
                ? {}
                : { preparedTargetedSurfaces: params.preparedTargetedSurfaces }),
            document: { version: 1, root: plainRendererRecord.root },
        });
    } catch (error) {
        if (error instanceof PluginDeclarativeDocumentNormalizationErrorV1) {
            throw modelError(error.code, error.message);
        }
        throw error;
    }

    const projectChildren = (children: readonly PluginDeclarativeNormalizedNodeV1[]) => Object.freeze(
        children.map(projectNode),
    );

    /**
     * Protocol has already parsed, bounded, traversed, and qualified this
     * candidate. The CLI owns only Settings compatibility and live Action
     * availability, so this projection must not re-resolve author references.
     */
    function projectNode(source: PluginDeclarativeNormalizedNodeV1): StablePluginDeclarativeNode {
        let projected: StablePluginDeclarativeNode;
        switch (source.kind) {
            case 'stack':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.direction ? { direction: source.direction } : {}),
                    ...(source.gap ? { gap: source.gap } : {}),
                    children: projectChildren(source.children),
                });
                break;
            case 'group':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.title ? { title: source.title } : {}),
                    ...(source.description ? { description: source.description } : {}),
                    children: projectChildren(source.children),
                });
                break;
            case 'list':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.label ? { label: source.label } : {}),
                    children: projectChildren(source.children),
                });
                break;
            case 'section':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.title ? { title: source.title } : {}),
                    ...(source.footer ? { footer: source.footer } : {}),
                    children: projectChildren(source.children),
                });
                break;
            case 'actionPanel':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.title ? { title: source.title } : {}),
                    children: projectChildren(source.children),
                });
                break;
            case 'field': {
                const setting = settingsByQualifiedId.get(source.setting.qualifiedId);
                if (!setting) {
                    throw modelError(
                        'plugin_declarative_setting_missing',
                        `Setting '${source.setting.qualifiedId}' is not declared`,
                    );
                }
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    label: source.label,
                    ...(source.description ? { description: source.description } : {}),
                    control: source.control,
                    setting: setting.setting,
                });
                break;
            }
            case 'action':
                if ('effect' in source) {
                    projected = Object.freeze({
                        kind: source.kind,
                        path: source.path,
                        order: source.order,
                        effect: source.effect,
                        label: source.label,
                        ...(source.variant ? { variant: source.variant } : {}),
                        // Composer availability is resolved only by the mounted
                        // Host API. A static declarative model cannot invent a
                        // second Composer currentness or revision decision.
                        enabled: true,
                    });
                } else {
                    projected = Object.freeze({
                        kind: source.kind,
                        path: source.path,
                        order: source.order,
                        action: source.action,
                        label: source.label,
                        ...(source.variant ? { variant: source.variant } : {}),
                        ...(source.input === undefined ? {} : { input: source.input }),
                        enabled: availability?.enabledActions[source.action.qualifiedId] === true,
                    });
                }
                break;
            case 'collectionList':
                for (const command of [
                    ...(source.primaryCommand ? [source.primaryCommand] : []),
                    ...(source.secondaryCommands ?? []),
                ]) {
                    if (command.kind === 'action') {
                        const action = actionsInventory.find((candidate) => (
                            candidate.qualifiedId === command.action.qualifiedId
                        ));
                        if (!action?.title) {
                            throw modelError(
                                'plugin_declarative_collection_command_presentation_missing',
                                `Collection row Action '${command.action.qualifiedId}' has no catalog presentation`,
                            );
                        }
                    }
                }
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.label ? { label: source.label } : {}),
                    source: source.source,
                    query: source.query,
                    projection: source.projection,
                    ...(source.primaryCommand ? { primaryCommand: source.primaryCommand } : {}),
                    ...(source.secondaryCommands ? { secondaryCommands: source.secondaryCommands } : {}),
                });
                break;
            case 'item':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    title: source.title,
                    ...(source.subtitle ? { subtitle: source.subtitle } : {}),
                    ...(source.detail ? { detail: source.detail } : {}),
                    ...(source.icon ? { icon: source.icon } : {}),
                    ...(source.tone ? { tone: source.tone } : {}),
                    ...(source.action
                        ? {
                            action: source.action,
                            ...(source.input === undefined ? {} : { input: source.input }),
                            enabled: availability?.enabledActions[source.action.qualifiedId] === true,
                        }
                        : {}),
                });
                break;
            case 'targetedSurface': {
                // The Protocol normalizer records the bounded fallback as a
                // regular preorder node. Project it through this same owner so
                // the stable node list never retains the placeholder that was
                // reserved while the parent target surface normalized.
                const fallback = source.fallback === undefined
                    ? undefined
                    : projectNode(source.fallback);
                if (fallback !== undefined && fallback.kind !== 'state') {
                    throw modelError('plugin_declarative_document_invalid', 'Targeted Surface fallback is not a state node');
                }
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    surface: source.surface,
                    input: source.input,
                    instanceKey: source.instanceKey,
                    ...(fallback === undefined ? {} : { fallback }),
                });
                break;
            }
            case 'state':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    state: source.state,
                    title: source.title,
                    ...(source.description ? { description: source.description } : {}),
                    ...(source.icon ? { icon: source.icon } : {}),
                });
                break;
            case 'metadata':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    ...(source.title ? { title: source.title } : {}),
                    entries: Object.freeze(source.entries.map((entry) => Object.freeze({
                        label: entry.label,
                        value: entry.value,
                        ...(entry.tone ? { tone: entry.tone } : {}),
                    }))),
                });
                break;
            case 'text':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    text: source.text,
                    ...(source.tone ? { tone: source.tone } : {}),
                });
                break;
            case 'markdown':
                projected = Object.freeze({ kind: source.kind, path: source.path, order: source.order, text: source.text });
                break;
            case 'status':
                projected = Object.freeze({
                    kind: source.kind,
                    path: source.path,
                    order: source.order,
                    label: source.label,
                    value: source.value,
                    ...(source.tone ? { tone: source.tone } : {}),
                });
                break;
            default: {
                const unreachable: never = source;
                throw modelError('plugin_declarative_document_invalid', `Unsupported declarative node '${JSON.stringify(unreachable)}'`);
            }
        }
        return projected;
    }

    const root = projectNode(document.root);
    const identity = createPluginContributionIdentity({ pluginId, localId: renderer.id });
    return Object.freeze({
        identity: Object.freeze({
            ...identity,
            qualifiedId: buildQualifiedPluginContributionKey(identity),
            generation,
        }),
        visible: availability?.visible ?? true,
        requiredHostMethods: Object.freeze([]),
        declarativeInventory: Object.freeze({
            actions: actionsInventory,
            destinations: destinationsInventory,
            settings: settingsInventory,
            uiQueries: uiQueriesInventory,
        }),
        root,
    });
}

function compilePayloadValidator(schema: HostStructuredMessageDescriptorV1['payloadSchema']) {
    try {
        return compilePluginJsonSchema(schema);
    } catch {
        throw modelError('plugin_structured_message_schema_invalid', 'Structured-message payload schema is invalid');
    }
}

function normalizeReferencedValues(params: Readonly<{
    ownerPluginId: string;
    generation: string;
    references: readonly PluginContributionReference[];
    inventory: ReadonlySet<string>;
    kind: 'action' | 'resource';
    enabledActions?: Readonly<Record<string, boolean>>;
}>): readonly (StablePluginQualifiedReference & Readonly<{ enabled?: boolean }>)[] {
    if (params.references.length > MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1) {
        throw modelError(`plugin_structured_message_${params.kind}s_bounded`, `Too many structured-message ${params.kind}s`);
    }
    const seen = new Set<string>();
    return Object.freeze(params.references.map((reference) => {
        let identity: PluginContributionIdentityV1;
        try {
            identity = normalizeReference(params.ownerPluginId, reference);
        } catch {
            throw modelError(
                `plugin_structured_message_${params.kind}_identity_invalid`,
                `Structured-message ${params.kind} identity is invalid`,
            );
        }
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        if (!params.inventory.has(qualifiedId)) {
            throw modelError(
                `plugin_structured_message_${params.kind}_missing`,
                `Structured-message ${params.kind} '${qualifiedId}' is not declared`,
            );
        }
        if (seen.has(qualifiedId)) {
            throw modelError(
                `plugin_structured_message_${params.kind}_duplicate`,
                `Structured-message ${params.kind} '${qualifiedId}' is duplicated`,
            );
        }
        seen.add(qualifiedId);
        const normalized = qualifiedReference(identity, params.generation);
        return params.kind === 'action'
            ? Object.freeze({ ...normalized, enabled: params.enabledActions?.[qualifiedId] === true })
            : normalized;
    }));
}

export function createStablePluginStructuredMessageModel(params: Readonly<{
    pluginId: string;
    generation: string;
    descriptor: HostStructuredMessageDescriptorV1;
    value: Readonly<{
        kind: string;
        payload: JsonValue;
        resources?: readonly PluginContributionReference[];
    }>;
    actions: readonly PluginContributionIdentityV1[];
    resources: readonly PluginContributionIdentityV1[];
    renderers: readonly PluginContributionIdentityV1[];
    availability?: StablePluginAvailabilityInput;
}>): StablePluginStructuredMessageModel {
    const pluginId = normalizePluginId(params.pluginId);
    const generation = normalizeGeneration(params.generation);
    const descriptor = cloneDomainPlainData(
        params.descriptor,
        'plugin_structured_message_invalid_plain_data',
        'descriptor',
    );
    if (!HostStructuredMessageDescriptorV1Schema.safeParse(descriptor).success) {
        throw modelError('plugin_structured_message_descriptor_invalid', 'Structured-message descriptor is invalid');
    }
    const value = cloneDomainPlainData(
        params.value,
        'plugin_structured_message_invalid_plain_data',
        'value',
    );
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw modelError('plugin_structured_message_value_invalid', 'Structured-message value is invalid');
    }
    const valueKeys = Object.keys(value);
    if (valueKeys.some((key) => key !== 'kind' && key !== 'payload' && key !== 'resources')
        || typeof value.kind !== 'string'
        || value.payload === undefined
        || (value.resources !== undefined && !Array.isArray(value.resources))) {
        throw modelError('plugin_structured_message_value_invalid', 'Structured-message value is invalid');
    }
    if (value.kind !== descriptor.kind) {
        throw modelError('plugin_structured_message_kind_mismatch', 'Structured-message kind does not match its descriptor');
    }
    const payloadBytes = textEncoder.encode(JSON.stringify(value.payload)).byteLength;
    if (payloadBytes > MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES) {
        throw modelError('plugin_structured_message_payload_bounded', 'Structured-message payload is too large');
    }
    if (!isValidPluginJsonSchemaValue(compilePayloadValidator(descriptor.payloadSchema), value.payload)) {
        throw modelError('plugin_structured_message_payload_invalid', 'Structured-message payload is invalid');
    }
    if (descriptor.fallback.kind === 'summary'
        && textEncoder.encode(descriptor.fallback.template).byteLength > MAX_FALLBACK_TEMPLATE_BYTES) {
        throw modelError('plugin_structured_message_fallback_bounded', 'Structured-message fallback is too large');
    }

    const actionKeys = buildIdentityInventory({
        values: params.actions,
        domain: 'action',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const resourceKeys = buildIdentityInventory({
        values: params.resources,
        domain: 'resource',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const rendererKeys = buildIdentityInventory({
        values: params.renderers,
        domain: 'renderer',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const availability = normalizeAvailability(
        params.availability,
        actionKeys,
        'plugin_structured_message_invalid_plain_data',
    );
    const rendererIdentity = createPluginContributionIdentity({ pluginId, localId: descriptor.renderer });
    const rendererKey = buildQualifiedPluginContributionKey(rendererIdentity);
    if (!rendererKeys.has(rendererKey)) {
        throw modelError('plugin_structured_message_renderer_missing', `Renderer '${rendererKey}' is not declared`);
    }
    const actions = normalizeReferencedValues({
        ownerPluginId: pluginId,
        generation,
        references: descriptor.actions ?? [],
        inventory: actionKeys,
        kind: 'action',
        enabledActions: availability?.enabledActions,
    }) as readonly (StablePluginQualifiedReference & Readonly<{ enabled: boolean }>)[];
    const resources = normalizeReferencedValues({
        ownerPluginId: pluginId,
        generation,
        references: value.resources ?? [],
        inventory: resourceKeys,
        kind: 'resource',
    }) as readonly StablePluginQualifiedReference[];
    const identity = createPluginContributionIdentity({ pluginId, localId: descriptor.id });
    return Object.freeze({
        identity: Object.freeze({
            ...identity,
            qualifiedId: buildQualifiedPluginContributionKey(identity),
            generation,
        }),
        kind: descriptor.kind,
        title: descriptor.title,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        payload: value.payload,
        renderer: qualifiedReference(rendererIdentity, generation),
        actions,
        resources,
        fallback: descriptor.fallback,
        visible: descriptor.availability ? availability?.visible === true : (availability?.visible ?? true),
        ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
    });
}
