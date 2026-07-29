import {
    MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1,
    PluginIdSchema,
    PluginStructuredMessageDescriptorV1Schema,
    PluginUiRendererV2Schema,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type PluginContributionIdentityV1,
    type PluginLocalizedStringV2,
    type PluginStructuredMessageDescriptorV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { type PluginSettingDescriptor } from '@happier-dev/plugin-sdk/runtime';

import { clonePluginPlainData } from '../../plainData';
import { compilePluginJsonSchema, containsEquivalentPluginJsonValue, isValidPluginJsonSchemaValue } from './jsonSchemaValidation';
import {
    type StablePluginSettingsField,
    type StablePluginSettingsModel,
    validateStablePluginSettingValue,
} from './settings';

const MAX_DECLARATIVE_NODES = 512;
const MAX_DECLARATIVE_DEPTH = 32;
const MAX_SELECT_OPTIONS = 128;
const MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STRUCTURED_MESSAGE_VALUE_STRING_BYTES = MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES + (256 * 1024);
const MAX_FALLBACK_TEMPLATE_BYTES = 4 * 1024;
const MAX_GENERATION_LENGTH = 256;
const textEncoder = new TextEncoder();

type PluginContributionReference = NonNullable<PluginStructuredMessageDescriptorV1['actions']>[number];

type DeclarativeControl =
    | Readonly<{ kind: 'text'; settingId: string }>
    | Readonly<{ kind: 'number'; settingId: string }>
    | Readonly<{ kind: 'toggle'; settingId: string }>
    | Readonly<{
        kind: 'select';
        settingId: string;
        options: readonly Readonly<{ value: JsonValue; label: PluginLocalizedStringV2 }>[];
    }>
    | Readonly<{ kind: 'secret'; settingId: string }>;

type DeclarativeSourceNode =
    | Readonly<{ kind: 'text'; text: PluginLocalizedStringV2; tone?: StablePluginDeclarativeTone }>
    | Readonly<{ kind: 'markdown'; text: PluginLocalizedStringV2 }>
    | Readonly<{
        kind: 'stack';
        direction?: 'vertical' | 'horizontal';
        gap?: 'small' | 'medium' | 'large';
        children: readonly DeclarativeSourceNode[];
    }>
    | Readonly<{
        kind: 'group';
        title?: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        children: readonly DeclarativeSourceNode[];
    }>
    | Readonly<{
        kind: 'field';
        label: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        control: DeclarativeControl;
    }>
    | Readonly<{
        kind: 'status';
        label: PluginLocalizedStringV2;
        value: PluginLocalizedStringV2;
        tone?: StablePluginDeclarativeTone;
    }>
    | Readonly<{
        kind: 'action';
        action: PluginContributionReference;
        label: PluginLocalizedStringV2;
        variant?: 'primary' | 'secondary' | 'destructive';
        input?: JsonValue;
    }>;

type DeclarativeSourceRenderer = Readonly<{
    id: string;
    kind: 'declarative';
    root: DeclarativeSourceNode;
    requiredHostMethods?: readonly string[];
}>;

export type StablePluginDeclarativeTone = 'default' | 'muted' | 'success' | 'warning' | 'danger';

export type StablePluginQualifiedReference = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
    generation: string;
}>;

type StablePluginDeclarativeNodeBase = Readonly<{
    path: string;
    order: number;
}>;

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
        control: DeclarativeControl;
        setting: StablePluginSettingsField;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'status';
        label: PluginLocalizedStringV2;
        value: PluginLocalizedStringV2;
        tone?: StablePluginDeclarativeTone;
    }>)
    | (StablePluginDeclarativeNodeBase & Readonly<{
        kind: 'action';
        action: StablePluginQualifiedReference;
        label: PluginLocalizedStringV2;
        variant?: 'primary' | 'secondary' | 'destructive';
        input?: JsonValue;
        enabled: boolean;
    }>);

export type StablePluginAvailabilityInput = Readonly<{
    visible: boolean;
    enabledActions: Readonly<Record<string, boolean>>;
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
    root: StablePluginDeclarativeNode;
    nodes: readonly StablePluginDeclarativeNode[];
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
    fallback: PluginStructuredMessageDescriptorV1['fallback'];
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
    limits?: Readonly<{ maxDepth?: number; maxNodes?: number; maxStringBytes?: number }>,
    limitCode?: string,
): T {
    return clonePluginPlainData(value, {
        path,
        ...(limits ? { limits } : {}),
        invalid: (message) => modelError(code, message),
        ...(limitCode ? { limitExceeded: (message: string) => modelError(limitCode, message) } : {}),
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
    domain: 'action' | 'resource' | 'renderer';
    invalidPlainDataCode: string;
}>): ReadonlySet<string> {
    const plainValues = cloneDomainPlainData(
        params.values,
        params.invalidPlainDataCode,
        params.domain,
        { maxDepth: 4, maxNodes: 512, maxStringBytes: 64 * 1024 },
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
        { maxDepth: 3, maxNodes: 512, maxStringBytes: 64 * 1024 },
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

function findSetting(
    settings: readonly StablePluginSettingsModel[],
    pluginId: string,
    settingId: string,
): Readonly<{ model: StablePluginSettingsModel; field: StablePluginSettingsField }> {
    const matches: Array<Readonly<{ model: StablePluginSettingsModel; field: StablePluginSettingsField }>> = [];
    for (const model of settings) {
        if (model.identity.pluginId !== pluginId) {
            throw modelError(
                'plugin_declarative_setting_scope_invalid',
                `Settings model '${model.identity.qualifiedId}' does not belong to '${pluginId}'`,
            );
        }
        for (const field of model.fields) {
            if (field.id === settingId) matches.push({ model, field });
        }
    }
    if (matches.length === 0) {
        throw modelError('plugin_declarative_setting_missing', `Setting '${settingId}' is not declared`);
    }
    if (matches.length > 1) {
        throw modelError('plugin_declarative_setting_ambiguous', `Setting '${settingId}' is ambiguous`);
    }
    return matches[0]!;
}

function readSchemaType(descriptor: PluginSettingDescriptor): unknown {
    if (!descriptor.schema || typeof descriptor.schema !== 'object' || Array.isArray(descriptor.schema)) return undefined;
    return (descriptor.schema as Readonly<Record<string, unknown>>).type;
}

function validateControl(
    control: DeclarativeControl,
    setting: Readonly<{ model: StablePluginSettingsModel; field: StablePluginSettingsField }>,
): void {
    const descriptor = setting.field.descriptor;
    const schemaType = readSchemaType(descriptor);
    if (control.kind === 'secret') {
        if (descriptor.secret !== true || schemaType !== 'string') {
            throw modelError('plugin_declarative_control_invalid', `Secret control '${control.settingId}' is incompatible`);
        }
        return;
    }
    if (descriptor.secret === true) {
        throw modelError('plugin_declarative_control_invalid', `Setting '${control.settingId}' requires a secret control`);
    }
    if ((control.kind === 'text' && schemaType !== 'string')
        || (control.kind === 'number' && schemaType !== 'number' && schemaType !== 'integer')
        || (control.kind === 'toggle' && schemaType !== 'boolean')) {
        throw modelError('plugin_declarative_control_invalid', `Control '${control.kind}' is incompatible with '${control.settingId}'`);
    }
    if (control.kind !== 'select') return;
    if (control.options.length > MAX_SELECT_OPTIONS) {
        throw modelError('plugin_declarative_options_bounded', `Select '${control.settingId}' has too many options`);
    }
    const seen: JsonValue[] = [];
    for (const option of control.options) {
        if (!validateStablePluginSettingValue(setting.model, control.settingId, option.value as JsonValue)) {
            throw modelError('plugin_declarative_option_invalid', `Select '${control.settingId}' has an invalid option`);
        }
        if (containsEquivalentPluginJsonValue(seen, option.value)) {
            throw modelError('plugin_declarative_option_duplicate', `Select '${control.settingId}' has duplicate options`);
        }
        seen.push(option.value);
    }
}

export function createStablePluginDeclarativeModel(params: Readonly<{
    pluginId: string;
    generation: string;
    renderer: unknown;
    settings: readonly StablePluginSettingsModel[];
    actions: readonly PluginContributionIdentityV1[];
    availability?: StablePluginAvailabilityInput;
}>): StablePluginDeclarativeModel {
    const pluginId = normalizePluginId(params.pluginId);
    const generation = normalizeGeneration(params.generation);
    const plainRenderer = cloneDomainPlainData(
        params.renderer,
        'plugin_declarative_invalid_plain_data',
        'renderer',
        { maxDepth: 48, maxNodes: 8_192, maxStringBytes: 256 * 1024 },
    );
    const parsedRenderer = PluginUiRendererV2Schema.safeParse(plainRenderer);
    if (!parsedRenderer.success || parsedRenderer.data.kind !== 'declarative') {
        throw modelError('plugin_declarative_renderer_invalid', 'Declarative renderer is invalid');
    }
    const renderer = plainRenderer as DeclarativeSourceRenderer;
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
    const nodes: StablePluginDeclarativeNode[] = [];

    function normalizeNode(source: DeclarativeSourceNode, path: string, depth: number): StablePluginDeclarativeNode {
        if (depth > MAX_DECLARATIVE_DEPTH) {
            throw modelError('plugin_declarative_depth_exceeded', 'Declarative renderer is too deeply nested');
        }
        if (nodes.length >= MAX_DECLARATIVE_NODES) {
            throw modelError('plugin_declarative_nodes_exceeded', 'Declarative renderer has too many nodes');
        }
        const order = nodes.length;
        nodes.push(undefined as unknown as StablePluginDeclarativeNode);
        let normalized: StablePluginDeclarativeNode;
        if (source.kind === 'stack' || source.kind === 'group') {
            const children = Object.freeze(source.children.map((child, index) => (
                normalizeNode(child, `${path}.children[${index}]`, depth + 1)
            )));
            normalized = source.kind === 'stack'
                ? Object.freeze({
                    kind: source.kind,
                    path,
                    order,
                    ...(source.direction ? { direction: source.direction } : {}),
                    ...(source.gap ? { gap: source.gap } : {}),
                    children,
                })
                : Object.freeze({
                    kind: source.kind,
                    path,
                    order,
                    ...(source.title ? { title: source.title } : {}),
                    ...(source.description ? { description: source.description } : {}),
                    children,
                });
        } else if (source.kind === 'field') {
            const setting = findSetting(params.settings, pluginId, source.control.settingId);
            validateControl(source.control, setting);
            normalized = Object.freeze({
                kind: source.kind,
                path,
                order,
                label: source.label,
                ...(source.description ? { description: source.description } : {}),
                control: source.control,
                setting: setting.field,
            });
        } else if (source.kind === 'action') {
            const identity = normalizeReference(pluginId, source.action);
            const qualifiedId = buildQualifiedPluginContributionKey(identity);
            if (!actionKeys.has(qualifiedId)) {
                throw modelError('plugin_declarative_action_missing', `Action '${qualifiedId}' is not declared`);
            }
            normalized = Object.freeze({
                kind: source.kind,
                path,
                order,
                action: qualifiedReference(identity, generation),
                label: source.label,
                ...(source.variant ? { variant: source.variant } : {}),
                ...(source.input === undefined ? {} : { input: source.input }),
                enabled: availability?.enabledActions[qualifiedId] === true,
            });
        } else if (source.kind === 'text') {
            normalized = Object.freeze({
                kind: source.kind,
                path,
                order,
                text: source.text,
                ...(source.tone ? { tone: source.tone } : {}),
            });
        } else if (source.kind === 'markdown') {
            normalized = Object.freeze({ kind: source.kind, path, order, text: source.text });
        } else {
            normalized = Object.freeze({
                kind: source.kind,
                path,
                order,
                label: source.label,
                value: source.value,
                ...(source.tone ? { tone: source.tone } : {}),
            });
        }
        nodes[order] = normalized;
        return normalized;
    }

    const root = normalizeNode(renderer.root, 'root', 0);
    const identity = createPluginContributionIdentity({ pluginId, localId: renderer.id });
    return Object.freeze({
        identity: Object.freeze({
            ...identity,
            qualifiedId: buildQualifiedPluginContributionKey(identity),
            generation,
        }),
        visible: availability?.visible ?? true,
        requiredHostMethods: Object.freeze([...(renderer.requiredHostMethods ?? [])]),
        root,
        nodes: Object.freeze(nodes),
    });
}

function compilePayloadValidator(schema: PluginStructuredMessageDescriptorV1['payloadSchema']) {
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
    if (params.references.length > MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1) {
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
    descriptor: PluginStructuredMessageDescriptorV1;
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
        { maxDepth: 48, maxNodes: 8_192, maxStringBytes: 256 * 1024 },
    );
    if (!PluginStructuredMessageDescriptorV1Schema.safeParse(descriptor).success) {
        throw modelError('plugin_structured_message_descriptor_invalid', 'Structured-message descriptor is invalid');
    }
    const value = cloneDomainPlainData(
        params.value,
        'plugin_structured_message_invalid_plain_data',
        'value',
        { maxDepth: 32, maxNodes: 16_384, maxStringBytes: MAX_STRUCTURED_MESSAGE_VALUE_STRING_BYTES },
        'plugin_structured_message_payload_bounded',
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
