import type { InputHints } from '../inputs/inputFields.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import type { WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
export { WidgetConnectedAccountPurposeBindingV1Schema, type WidgetConnectedAccountPurposeBindingV1 } from './widgetConnectedAccountPurposeBindingV1.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, type PluginJsonSchemaValidator } from '../plugins/actions/jsonSchemaValidation.js';
import { resolveWidgetBindingsV1, type WidgetBindingResolutionInputV1, type WidgetBindingResolutionV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';

export type WidgetInputDescriptorV1 = Readonly<{
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

/** Discover only declared target intent before reaching its own Resource/purpose authority. */
export function resolveConfiguredWidgetTargetInputV1(options: ConfiguredWidgetInputsV1): WidgetBindingResolutionV1 {
    const path = options.descriptor.sessionInputPath;
    if (!path) return { status: 'unavailable', fields: [{ path: 'session', status: 'unavailable', reasonCode: 'widget_session_input_undeclared' }] };
    return resolveWidgetBindingsV1({ instance: options.instance, fields: options.descriptor.inputs?.fields ?? [],
        context: options.providedContext, viewerValues: options.viewerValues,
        validateValue: options.validateValue ?? (() => ({ status: 'valid' })), resolvePaths: [path] });
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
