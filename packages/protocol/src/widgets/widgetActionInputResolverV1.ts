import { isSameInputOptionValue, type InputFieldHint, type InputOptionValue } from '../inputs/inputFields.js';
import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import type { WidgetActionInputResolverV1 } from './actionsV1.js';
import { resolveConfiguredWidgetInputs, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetBindingResolutionInputV1, WidgetInputIssueV1 } from './widgetInstanceV1.js';
import { validateInputTypeValue, type ResolvedInputTypeV1 } from '../inputs/inputTypeRuntime.js';

type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
type Validation = ReturnType<WidgetBindingResolutionInputV1['validateValue']>;
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
    return { resolve: async request => {
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        if (!descriptor) return { status: 'unavailable', fields: [{ path: 'input', status: 'unavailable', reasonCode: 'widget_type_unavailable' }] };
        const [providedContext, currentViewer] = await Promise.all([ports.readContext(request), ports.readViewerValues(request)]);
        request.signal?.throwIfAborted();
        const resolved = resolveConfiguredWidgetInputs({ instance: request.instance, descriptor, providedContext, viewerValues: currentViewer.values });
        if (resolved.status !== 'ready' || currentViewer.fields?.length) {
            const fields = [...currentViewer.fields ?? [], ...(resolved.status === 'ready' ? [] : resolved.fields.filter(field =>
                !currentViewer.fields?.some(current => current.path === field.path)))];
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
