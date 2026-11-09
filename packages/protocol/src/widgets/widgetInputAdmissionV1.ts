import type { InputHints } from '../inputs/inputFields.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import type { WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
import type { WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';
import type { WidgetPublicSnapshotPresentationV1 } from './widgetPublicSnapshotV1.js';
import type { WidgetDefinitionV1 } from './widgetDefinitionV1.js';
import type { PLUGIN_UI_INLINE_SURFACE_SLOTS_V1 } from '../plugins/contributions/ui/surfaceRegistry.js';
export { WidgetConnectedAccountPurposeBindingV1Schema, type WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, type PluginJsonSchemaValidator } from '../plugins/actions/jsonSchemaValidation.js';
import { resolveWidgetBindingsV1, type WidgetInputBindingsV1, type WidgetBindingResolutionInputV1, type WidgetBindingResolutionV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '../workspaces/workspaceRefV1.js';
import { resolveWorkspaceRefV1, workspaceAddressFromRefV1, type WorkspaceRefResolutionContextV1 } from '../workspaces/workspaceRefResolutionV1.js';

export type WidgetInputDescriptorV1 = Readonly<{
    /** Current installed declaration metadata; never persisted in an instance or bound input. */
    target?: keyof typeof PLUGIN_UI_INLINE_SURFACE_SLOTS_V1.widget.targets;
    publicPresentation?: WidgetPublicSnapshotPresentationV1;
    authoredDefinition?: WidgetDefinitionV1;
    sizeDeclaration?: WidgetSizeDeclarationV1;
    inputs?: InputHints;
    inputSchema?: PluginJsonSchemaV2;
    sessionInputPath?: string;
    connectedAccountPurposeBindings?: readonly WidgetConnectedAccountPurposeBindingV1[];
}>;
export type ConfiguredWidgetInputsV1 = Readonly<{
    instance: WidgetInstanceV1;
    descriptor: WidgetInputDescriptorV1;
    providedContext: WidgetBindingResolutionInputV1['context'];
    viewerValues: WidgetBindingResolutionInputV1['viewerValues'];
    validateValue?: WidgetBindingResolutionInputV1['validateValue'];
}>;

/** Declared literal defaults fill only unbound fields; the normal binder still admits them. */
export function proposeWidgetInputDefaultBindingsV1(descriptor: WidgetInputDescriptorV1, initial: WidgetInputBindingsV1 = {}): WidgetInputBindingsV1 {
    const bindings = { ...initial };
    for (const field of descriptor.inputs?.fields ?? []) {
        if (Object.hasOwn(bindings, field.path) || field.connectedAccountOptions === true || field.widget === 'secret') continue;
        let schema = descriptor.inputSchema;
        for (const segment of field.path.split('.')) schema = schema?.properties?.[segment];
        if (schema?.default !== undefined) bindings[field.path] = { kind: 'value', value: schema.default };
    }
    return bindings;
}

// Declaration objects have immutable schema identity; authority is checked anew below.
const validators = new WeakMap<PluginJsonSchemaV2, PluginJsonSchemaValidator>();

export type WidgetInputTargetV1 = Readonly<{ kind: 'app' }>
    | Readonly<{ kind: 'session' | 'workspace'; path: string }>
    | Readonly<{ kind: 'invalid'; paths: readonly string[]; reasonCode: 'widget_target_ambiguous' }>;

/** Field declarations own native targets. Installed declarations retain their exact Session ABI. */
export function readWidgetInputTargetV1(descriptor: WidgetInputDescriptorV1): WidgetInputTargetV1 {
    const targets = new Map<string, Extract<WidgetInputTargetV1, { path: string }>>();
    for (const field of descriptor.inputs?.fields ?? []) {
        const type = field.inputType;
        if (type && 'hostType' in type && (type.hostType === 'session' || type.hostType === 'workspace')) {
            targets.set(`${type.hostType}:${field.path}`, { kind: type.hostType, path: field.path });
        }
    }
    if (descriptor.sessionInputPath) targets.set(`session:${descriptor.sessionInputPath}`, { kind: 'session', path: descriptor.sessionInputPath });
    const declared = [...targets.values()];
    if (declared.length > 1) return { kind: 'invalid', paths: declared.map(target => target.path), reasonCode: 'widget_target_ambiguous' };
    return declared[0] ?? { kind: 'app' };
}

/** Project declarations require host-owned Project context; other targets retain their input admission. */
export function isWidgetTargetHostableV1(descriptor: WidgetInputDescriptorV1, surface: string): boolean {
    return (descriptor.target !== 'project' || surface === 'project') && readWidgetInputTargetV1(descriptor).kind !== 'invalid';
}

/** Discover only declared target intent before reaching its own Resource/purpose authority. */
export function resolveConfiguredWidgetTargetInputV1(options: ConfiguredWidgetInputsV1): WidgetBindingResolutionV1 {
    const target = readWidgetInputTargetV1(options.descriptor);
    if (target.kind === 'invalid') return { status: 'invalid', fields: target.paths.map(path => ({ path, status: 'invalid', reasonCode: target.reasonCode })) };
    if (target.kind === 'app') return resolveConfiguredWidgetInputs(options);
    return resolveWidgetBindingsV1({ instance: options.instance, fields: options.descriptor.inputs?.fields ?? [],
        context: options.providedContext, viewerValues: options.viewerValues,
        validateValue: options.validateValue ?? (() => ({ status: 'valid' })), resolvePaths: [target.path] });
}

export function resolveConfiguredWidgetInputs(options: ConfiguredWidgetInputsV1): WidgetBindingResolutionV1 {
    const resolved = resolveWidgetBindingsV1({
        instance: options.instance,
        fields: options.descriptor.inputs?.fields ?? [],
        context: options.providedContext,
        viewerValues: options.viewerValues,
        validateValue: options.validateValue ?? (() => ({ status: 'valid' })),
    });
    if (resolved.status !== 'ready') return resolved;
    const schema = options.descriptor.inputSchema;
    if (!schema) return resolved;
    let validate = validators.get(schema);
    if (!validate) {
        validate = compilePluginJsonSchema(schema);
        validators.set(schema, validate);
    }
    if (isValidPluginJsonSchemaValue(validate, resolved.input)) return resolved;
    return { status: 'invalid', fields: (options.descriptor.inputs?.fields ?? []).map(field => ({
        path: field.path, status: 'invalid', reasonCode: 'widget_input_schema_invalid',
    })) };
}

/** Authorized Project rows supply checkout facts; bindings and page context never grant access. */
export function validateWidgetWorkspaceInputV1(input: Readonly<{
    value: JsonValue;
    serverId: string;
    workspaceRefs: readonly WorkspaceRefV1[];
}>, context: WorkspaceRefResolutionContextV1 = {}): Readonly<{ status: 'valid'; checkout: WorkspaceRefV1 }>
    | Readonly<{ status: 'invalid' | 'denied'; reasonCode: string }> {
    const selected = WorkspaceRefV1Schema.safeParse(input.value);
    if (!selected.success) return { status: 'invalid', reasonCode: 'widget_workspace_selection_invalid' };
    const selectedServerId = context.normalizeServerId?.(selected.data.serverId) ?? selected.data.serverId;
    const scopeServerId = context.normalizeServerId?.(input.serverId) ?? input.serverId;
    if (selectedServerId !== scopeServerId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    const admitted = resolveWorkspaceRefV1(input.workspaceRefs, workspaceAddressFromRefV1(selected.data), context);
    return admitted.kind === 'resolved' ? { status: 'valid', checkout: admitted.ref }
        : { status: 'denied', reasonCode: 'widget_target_identity_mismatch' };
}
