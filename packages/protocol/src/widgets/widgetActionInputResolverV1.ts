import { isSameInputOptionValue, type InputFieldHint, type InputOptionValue } from '../inputs/inputFields.js';
import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import type { WidgetActionInputResolverV1 } from './actionsV1.js';
import { resolveConfiguredWidgetInputs, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { WidgetInstanceV1Schema, type WidgetBindingResolutionInputV1, type WidgetInputIssueV1 } from './widgetInstanceV1.js';
import { validateInputTypeValue, type ResolvedInputTypeV1 } from '../inputs/inputTypeRuntime.js';
import { hasValidPluginConnectedAccountPurposeBindingsV2 } from '../plugins/actions/v2.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import { WidgetConnectedAccountPurposeBindingV1Schema } from './widgetConnectedAccountPurposeBindingV1.js';
import { WidgetSizeDeclarationV1Schema } from './widgetPresentationV1.js';

type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
type Validation = ReturnType<WidgetBindingResolutionInputV1['validateValue']>;

/** Configuration has no viewer value yet; keep every constraint on the saved values. */
function configurationSchema(schema: PluginJsonSchemaV2, paths: readonly string[]): PluginJsonSchemaV2 {
    const projected = { ...schema };
    let changed = false;
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        if (schema[key]) projected[key] = schema[key].map(arm => {
            const next = configurationSchema(arm, paths);
            changed ||= next !== arm;
            return next;
        });
    }
    if (schema.properties) projected.properties = Object.fromEntries(Object.entries(schema.properties).flatMap(([key, value]) => {
        if (paths.includes(key)) { changed = true; return []; }
        const nested = paths.filter(path => path.startsWith(`${key}.`)).map(path => path.slice(key.length + 1));
        const next = nested.length ? configurationSchema(value, nested) : value;
        changed ||= next !== value;
        return [[key, next]];
    }));
    if (schema.required) projected.required = schema.required.filter(key => {
        if (paths.includes(key)) return false;
        if (!paths.some(path => path.startsWith(`${key}.`))) return true;
        const child = projected.properties?.[key];
        const hasRequired = (value: PluginJsonSchemaV2): boolean => Boolean(value.required?.length
            || [...value.oneOf ?? [], ...value.anyOf ?? [], ...value.allOf ?? []].some(hasRequired));
        return !child || hasRequired(child);
    });
    changed ||= projected.required?.length !== schema.required?.length;
    if (schema.oneOf && projected.oneOf?.some((arm, index) => arm !== schema.oneOf![index])) {
        // Deferred viewer input needs a possible arm, not exclusivity before its value exists.
        // Execution always uses the original schema and its exclusive oneOf contract.
        if (projected.anyOf) projected.allOf = [...projected.allOf ?? [], { anyOf: projected.oneOf }];
        else projected.anyOf = projected.oneOf;
        delete projected.oneOf;
    }
    return changed ? projected : schema;
}
export type WidgetActionInputResolverPortsV1 = Readonly<{
    readDescriptor(request: Request): Promise<WidgetInputDescriptorV1 | null>;
    readContext(request: Request): Promise<WidgetBindingResolutionInputV1['context']>;
    readViewerValues(request: Request): Promise<Readonly<{ values: WidgetBindingResolutionInputV1['viewerValues']; fields?: readonly WidgetInputIssueV1[] }>>;
    validateValue(field: InputFieldHint, value: JsonValue, request: Request): Promise<Validation>;
    readInputType?(field: InputFieldHint, request: Request): Promise<ResolvedInputTypeV1 | null>;
    resolveOptions(field: InputFieldHint, input: Readonly<Record<string, JsonValue>>, request: Request): Promise<
        readonly Readonly<{ value: InputOptionValue; disabled?: boolean }>[] | Exclude<Validation, { status: 'valid' }>>;
}>;

/** Host ports supply current facts; neutral binding/schema/options rules have one owner. */
export function createWidgetActionInputResolverV1(ports: WidgetActionInputResolverPortsV1): WidgetActionInputResolverV1 {
    return { readSizeDeclaration: async request => {
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        const declaration = WidgetSizeDeclarationV1Schema.safeParse(descriptor?.sizeDeclaration);
        return declaration.success ? declaration.data : null;
    }, resolve: async request => {
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        if (!descriptor) return { status: 'unavailable', fields: [{ path: 'input', status: 'unavailable', reasonCode: 'widget_type_unavailable' }] };
        const savedInstance = WidgetInstanceV1Schema.parse(request.instance);
        const [providedContext, currentViewer] = await Promise.all([ports.readContext(request), ports.readViewerValues(request)]);
        request.signal?.throwIfAborted();
        const viewerPaths = request.admission === 'configuration'
            ? Object.entries(savedInstance.bindings).filter(([, binding]) => binding.kind === 'viewer').map(([path]) => path) : [];
        const declarations = descriptor.connectedAccountPurposeBindings ?? [];
        const declarationIssues: WidgetInputIssueV1[] = viewerPaths.flatMap(path => {
            const binding = savedInstance.bindings[path]!;
            const mappings = declarations.filter(mapping => mapping.path === path && binding.kind === 'viewer' && mapping.purpose === binding.purpose);
            const declared = descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions === true)
                && mappings.length === 1 && WidgetConnectedAccountPurposeBindingV1Schema.safeParse(mappings[0]).success
                && hasValidPluginConnectedAccountPurposeBindingsV2(descriptor.inputSchema, declarations);
            if (!declared) return [{ path, status: 'unavailable' as const, reasonCode: 'widget_viewer_purpose_undeclared' }];
            // Empty host facts are not proof that the purpose's Resource exists.
            const currentPurpose = currentViewer.values[path] !== undefined || currentViewer.fields?.some(field => field.path === path
                && field.status === 'selection_required' && field.reasonCode === 'widget_viewer_connection_missing');
            return currentPurpose ? [] : [{ path, status: 'unavailable' as const, reasonCode: 'widget_viewer_purpose_authority_unavailable' }];
        });
        // The purpose owner still proves the Resource declaration; only a missing current connection is deferred.
        const hostViewerIssues = (currentViewer.fields ?? []).filter(field => !viewerPaths.includes(field.path)
            || field.status !== 'selection_required' || field.reasonCode !== 'widget_viewer_connection_missing');
        const viewerIssues = [...hostViewerIssues, ...declarationIssues.filter(issue => !hostViewerIssues.some(field => field.path === issue.path))];
        const admittedDescriptor = viewerPaths.length ? { ...descriptor,
            inputs: { fields: (descriptor.inputs?.fields ?? []).map(field => viewerPaths.includes(field.path)
                ? { ...field, required: false, requiredWhen: undefined } : field) },
            ...(descriptor.inputSchema ? { inputSchema: configurationSchema(descriptor.inputSchema, viewerPaths) } : {}),
        } : descriptor;
        const instance = viewerPaths.length ? { ...savedInstance,
            bindings: Object.fromEntries(Object.entries(savedInstance.bindings).filter(([path]) => !viewerPaths.includes(path))) } : savedInstance;
        const resolved = resolveConfiguredWidgetInputs({ instance, descriptor: admittedDescriptor, providedContext, viewerValues: currentViewer.values });
        if (resolved.status !== 'ready' || viewerIssues.length) {
            const fields = [...viewerIssues, ...(resolved.status === 'ready' ? [] : resolved.fields.filter(field =>
                !viewerIssues.some(current => current.path === field.path)))];
            const status = (['denied', 'invalid', 'unavailable', 'selection_required'] as const).find(status => fields.some(field => field.status === status))!;
            return { status, fields };
        }
        const issues: WidgetInputIssueV1[] = [];
        for (const field of resolveEffectiveInputFields({ inputHints: descriptor.inputs }, resolved.input, { includeHidden: true })) {
            const value = readInputPath(resolved.input, field.path) as JsonValue | undefined;
            if (value === undefined) continue;
            const validation = await ports.validateValue(field, value, request);
            request.signal?.throwIfAborted();
            if (validation.status !== 'valid') { issues.push({ path: field.path, ...validation }); continue; }
            if (field.inputType) {
                const type = await ports.readInputType?.(field, request);
                request.signal?.throwIfAborted();
                if (!type || type.identity.pluginId !== field.inputType.pluginId || type.identity.localId !== field.inputType.localId) {
                    issues.push({ path: field.path, status: 'unavailable', reasonCode: 'input_type_unavailable' }); continue;
                }
                const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
                const invalid = values.map(value => validateInputTypeValue(type, value)).find(result => result.status === 'invalid');
                if (invalid?.status === 'invalid') { issues.push({ path: field.path, status: 'invalid', reasonCode: invalid.reasonCode }); continue; }
                const current = await ports.readInputType?.(field, request);
                if (!current || current.occurrenceId !== type.occurrenceId) {
                    issues.push({ path: field.path, status: 'unavailable', reasonCode: 'input_type_retired' }); continue;
                }
                if (!type.definition.options && !field.options?.length && !field.optionsSourceId) continue;
            }
            // Existing-purpose defaults have passed current host value admission.
            // An authored source/type/static constraint is never bypassed here.
            if (request.instance.bindings[field.path]?.kind === 'viewer' && field.connectedAccountOptions === true
                && !field.options?.length && !field.optionsSourceId && !field.inputType) continue;
            if (!field.options?.length && !field.optionsSourceId && !field.inputType && !field.connectedAccountOptions) continue;
            const options = field.options?.length ? field.options : await ports.resolveOptions(field, resolved.input, request);
            request.signal?.throwIfAborted();
            if (!Array.isArray(options)) {
                const refusal = options as Exclude<Validation, { status: 'valid' }>;
                issues.push({ path: field.path, ...refusal });
                continue;
            }
            const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
            if (values.some(selected => !options.some(option => option.disabled !== true && isSameInputOptionValue(option.value, selected))))
                issues.push({ path: field.path, status: 'invalid', reasonCode: 'widget_input_option_unavailable' });
        }
        if (!issues.length) return resolved;
        const status = (['denied', 'invalid', 'unavailable'] as const).find(status => issues.some(issue => issue.status === status))!;
        return { status, fields: issues };
    } };
}
