import type { InputHints } from '../inputs/inputFields.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import type { WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
import type { WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';
export { WidgetConnectedAccountPurposeBindingV1Schema, type WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, type PluginJsonSchemaValidator } from '../plugins/actions/jsonSchemaValidation.js';
import { resolveWidgetBindingsV1, type WidgetBindingResolutionInputV1, type WidgetBindingResolutionV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '../workspaces/workspaceRefV1.js';
import { resolveWorkspaceRefV1, workspaceAddressFromRefV1 } from '../workspaces/workspaceRefResolutionV1.js';

export type WidgetInputDescriptorV1 = Readonly<{
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

/**
 * Whether a surface can host a widget with this target. A checkout (workspace) target needs a surface
 * that supplies the checkout — a Project's areas; no other surface can fill or choose it.
 */
export function isWidgetTargetHostableV1(descriptor: WidgetInputDescriptorV1, surface: string): boolean {
    return readWidgetInputTargetV1(descriptor).kind !== 'workspace' || surface === 'project';
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

/** Context supplies admitted checkout facts; a saved value never supplies read authority. */
export function validateWidgetWorkspaceInputV1(input: Readonly<{
    value: JsonValue;
    serverId: string;
    contextValues: readonly JsonValue[];
}>): Readonly<{ status: 'valid'; checkout: WorkspaceRefV1 }>
    | Readonly<{ status: 'invalid' | 'denied'; reasonCode: string }> {
    const selected = WorkspaceRefV1Schema.safeParse(input.value);
    if (!selected.success) return { status: 'invalid', reasonCode: 'widget_workspace_selection_invalid' };
    if (selected.data.serverId !== input.serverId) return { status: 'denied', reasonCode: 'widget_target_scope_mismatch' };
    const refs = input.contextValues.flatMap(value => {
        const ref = WorkspaceRefV1Schema.safeParse(value);
        return ref.success ? [ref.data] : [];
    });
    const admitted = resolveWorkspaceRefV1(refs, workspaceAddressFromRefV1(selected.data));
    return admitted.kind === 'resolved' ? { status: 'valid', checkout: admitted.ref }
        : { status: 'denied', reasonCode: 'widget_target_identity_mismatch' };
}
