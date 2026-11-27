import type { InputFieldHint, InputOptionValue } from '../inputs/inputFields.js';
import { resolveEffectiveInputFields } from '../inputs/inputFieldRuntime.js';
import { readInputPath } from '../inputs/inputPredicates.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import type { WidgetActionInputResolverV1 } from './actionsV1.js';
import { isUsageMainWidgetSurfaceV1, readUsagePageWidgetFollowBindingsV1 } from './usageWidgetPresetsV1.js';
import { isWidgetTargetHostableV1, resolveConfiguredWidgetInputs, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { WidgetInstanceV1Schema, type WidgetBindingResolutionInputV1, type WidgetInputIssueV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { readInputFieldOptionsConstraint, readInputFieldSelectedValues, validateInputFieldSchema, validateInputFieldValue, type ResolvedInputTypeV1 } from '../inputs/inputTypeRuntime.js';
import { hasValidPluginConnectedAccountPurposeBindingsV2 } from '../plugins/actions/v2.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import { WidgetConnectedAccountPurposeBindingV1Schema } from './widgetConnectedAccountPurposeBindingV1.js';
import { WidgetSizeDeclarationV1Schema } from './widgetPresentationV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { readWidgetConnectedAccountPurposeV1 } from './widgetViewerPurposeV1.js';
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { PluginProjectedResourceV2 } from '../daemon/contributionRegistryProjection.js';
import { isPublicProfileWidgetSurfaceV1, resolveWidgetPublicProfileInputsV1 } from './widgetPublicProfileAdmissionV1.js';

type Request = Parameters<WidgetActionInputResolverV1['resolve']>[0];
type Validation = ReturnType<WidgetBindingResolutionInputV1['validateValue']>;

/** Destination identity fills its intrinsic slots; group pins override values, never access. */
export function composeWidgetGroupContextV1(input: Readonly<{
    providedContext: WidgetBindingResolutionInputV1['context'];
    surfaceOwner?: WidgetSurfaceRefV1['owner'];
    groupBindings?: WidgetInputBindingsV1;
}>): WidgetBindingResolutionInputV1['context'] {
    // Project identity fills an absent slot without a mount, Source, or checkout.
    // Preserve an exact mounted area's supplied value (including unavailable),
    // since an attached layout's storage owner can differ from its viewing Project.
    const providedContext = input.surfaceOwner?.kind === 'project' && input.providedContext.projects === undefined
        ? { ...input.providedContext, projects: [[input.surfaceOwner.projectId]] } : input.providedContext;
    if (!input.groupBindings || !Object.keys(input.groupBindings).length) return providedContext;
    return { ...providedContext, ...Object.fromEntries(Object.entries(input.groupBindings).map(([slot, binding]) => [slot,
        binding.kind === 'value' ? [binding.value] : binding.kind === 'context' ? providedContext[binding.slot] ?? [] : [],
    ])) };
}

/** A following child inherits viewer intent, never a group's private selection. */
export function inheritWidgetGroupViewerBindingsV1(instance: WidgetInstanceV1, groupBindings: WidgetInputBindingsV1 | undefined, fields: readonly InputFieldHint[]): WidgetInstanceV1 {
    if (!groupBindings) return instance;
    let changed = false;
    const bindings = Object.fromEntries(Object.entries(instance.bindings).map(([path, binding]) => {
        const field = fields.find(field => field.path === path);
        if (!field?.connectedAccountOptions || field.contextMode === 'own') return [path, binding];
        const inherited = binding.kind === 'context' ? groupBindings[binding.slot] : undefined;
        if (inherited?.kind !== 'viewer') return [path, binding];
        changed = true;
        return [path, inherited];
    }));
    return changed ? { ...instance, bindings } : instance;
}

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
    readDescriptor(request: Request): Promise<(WidgetInputDescriptorV1 & Readonly<{
        resources?: readonly PluginContributionIdentityV1[]; resourceDeclarations?: readonly PluginProjectedResourceV2[];
    }>) | null>;
    readContext(request: Request): Promise<WidgetBindingResolutionInputV1['context']>;
    readGroupBindings?(request: Request): Promise<WidgetInputBindingsV1 | undefined>;
    readViewerValues(request: Request): Promise<Readonly<{ values: WidgetBindingResolutionInputV1['viewerValues']; fields?: readonly WidgetInputIssueV1[] }>>;
    validateValue(field: InputFieldHint, value: JsonValue, request: Request): Promise<Validation>;
    readInputType?(field: InputFieldHint, request: Request): Promise<ResolvedInputTypeV1 | null>;
    /** `values` are the picked values to check: a source that can answer them directly need not read its whole inventory. */
    resolveOptions(field: InputFieldHint, input: Readonly<Record<string, JsonValue>>, request: Request, values: readonly JsonValue[]): Promise<
        readonly Readonly<{ value: InputOptionValue; disabled?: boolean }>[] | Exclude<Validation, { status: 'valid' }>>;
}>;

/** Host ports supply current facts; neutral binding/schema/options rules have one owner. */
export function createWidgetActionInputResolverV1(ports: WidgetActionInputResolverPortsV1): WidgetActionInputResolverV1 {
    return { readSizeDeclaration: async initialRequest => {
        const request = { ...initialRequest };
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        const declaration = WidgetSizeDeclarationV1Schema.safeParse(descriptor?.sizeDeclaration);
        return declaration.success ? declaration.data : null;
    }, readUsagePageFollowBindings: async request => {
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        return descriptor ? readUsagePageWidgetFollowBindingsV1(descriptor) : null;
    }, resolve: async initialRequest => {
        const request = { ...initialRequest };
        request.signal?.throwIfAborted();
        const groupBindings = request.groupBindings ?? await ports.readGroupBindings?.(request);
        request.groupBindings = groupBindings;
        request.signal?.throwIfAborted();
        const descriptor = await ports.readDescriptor(request);
        request.signal?.throwIfAborted();
        if (!descriptor) return { status: 'unavailable', fields: [{ path: 'input', status: 'unavailable', reasonCode: 'widget_type_unavailable' }] };
        if (isPublicProfileWidgetSurfaceV1(request.ref.surface)) return resolveWidgetPublicProfileInputsV1(request.instance, descriptor, groupBindings);
        if (!isWidgetTargetHostableV1(descriptor, request.ref.surface.owner.kind)) {
            return { status: 'denied', fields: [{ path: 'input', status: 'denied', reasonCode: 'widget_target_surface_unsupported' }] };
        }
        request.instance = inheritWidgetGroupViewerBindingsV1(request.instance, groupBindings, descriptor.inputs?.fields ?? []);
        const savedInstance = WidgetInstanceV1Schema.parse(request.instance);
        const [surfaceContext, currentViewer] = await Promise.all([ports.readContext(request), ports.readViewerValues(request)]);
        const providedContext = composeWidgetGroupContextV1({ providedContext: surfaceContext, surfaceOwner: request.ref.surface.owner, groupBindings });
        request.signal?.throwIfAborted();
        const viewerPaths = request.admission === 'configuration'
            ? Object.entries(savedInstance.bindings).filter(([, binding]) => binding.kind === 'viewer').map(([path]) => path) : [];
        const { configurationPatch } = request;
        const usagePageFollowers = request.admission === 'configuration' && isUsageMainWidgetSurfaceV1(request.ref.surface)
            ? readUsagePageWidgetFollowBindingsV1(descriptor) : null;
        const contextPaths = request.admission === 'configuration' && (configurationPatch || usagePageFollowers)
            ? Object.entries(savedInstance.bindings).flatMap(([path, binding]) => {
                const field = descriptor.inputs?.fields.find(field => field.path === path);
                if (binding.kind !== 'context' || !field || field.contextMode === 'own' || providedContext[binding.slot] !== undefined) return [];
                if (configurationPatch) {
                    return !configurationPatch.paths.includes(path) && sameStrictJsonValue(binding, configurationPatch.previousBindings[path])
                        ? [path] : [];
                }
                // A saved Usage page follower names a declared slot. The mounted page supplies
                // its value on execution; an independent add or validation has no current page.
                return sameStrictJsonValue(binding, usagePageFollowers?.[path]) ? [path] : [];
            }) : [];
        const deferredPaths = [...viewerPaths, ...contextPaths];
        const declarations = descriptor.connectedAccountPurposeBindings ?? [];
        const declarationIssues: WidgetInputIssueV1[] = viewerPaths.flatMap(path => {
            const binding = savedInstance.bindings[path]!;
            const mappings = declarations.filter(mapping => mapping.path === path && binding.kind === 'viewer' && mapping.purpose === binding.purpose);
            const declared = descriptor.inputs?.fields.some(field => field.path === path && field.connectedAccountOptions === true)
                && mappings.length === 1 && WidgetConnectedAccountPurposeBindingV1Schema.safeParse(mappings[0]).success
                && hasValidPluginConnectedAccountPurposeBindingsV2(descriptor.inputSchema, declarations);
            if (!declared) return [{ path, status: 'unavailable' as const, reasonCode: 'widget_viewer_purpose_undeclared' }];
            // Empty host facts are not proof that the purpose's Resource exists.
            const currentPurpose = binding.kind === 'viewer' && readWidgetConnectedAccountPurposeV1({ descriptor,
                resources: descriptor.resourceDeclarations ?? [], path, purpose: binding.purpose }) !== null
                || currentViewer.values[path] !== undefined || currentViewer.fields?.some(field => field.path === path
                && field.status === 'selection_required' && field.reasonCode === 'widget_viewer_connection_missing');
            return currentPurpose ? [] : [{ path, status: 'unavailable' as const, reasonCode: 'widget_viewer_purpose_authority_unavailable' }];
        });
        // The purpose owner still proves the Resource declaration; only a missing current connection is deferred.
        const hostViewerIssues = (currentViewer.fields ?? []).filter(field => !viewerPaths.includes(field.path)
            || field.status !== 'selection_required' || field.reasonCode !== 'widget_viewer_connection_missing');
        const viewerIssues = [...hostViewerIssues, ...declarationIssues.filter(issue => !hostViewerIssues.some(field => field.path === issue.path))];
        const admittedDescriptor = deferredPaths.length ? { ...descriptor,
            inputs: { fields: (descriptor.inputs?.fields ?? []).filter(field => !contextPaths.includes(field.path))
                .map(field => viewerPaths.includes(field.path) ? { ...field, required: false, requiredWhen: undefined } : field) },
            ...(descriptor.inputSchema ? { inputSchema: configurationSchema(descriptor.inputSchema, deferredPaths) } : {}),
        } : descriptor;
        const instance = deferredPaths.length ? { ...savedInstance,
            bindings: Object.fromEntries(Object.entries(savedInstance.bindings).filter(([path]) => !deferredPaths.includes(path))) } : savedInstance;
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
            const type = field.inputType && 'pluginId' in field.inputType ? await ports.readInputType?.(field, request) : undefined;
            request.signal?.throwIfAborted();
            const schema = validateInputFieldSchema({ field, value, type });
            const issue = (result: Exclude<ReturnType<typeof validateInputFieldValue>, { status: 'valid' }>) => ({ path: field.path,
                ...result, reasonCode: result.reasonCode === 'input_type_option_invalid' ? 'widget_input_option_unavailable' : result.reasonCode });
            if (schema.status !== 'valid') { issues.push(issue(schema)); continue; }
            const contextBound = request.instance.bindings[field.path]?.kind === 'context';
            const constraint = readInputFieldOptionsConstraint(field, type, request.instance.bindings[field.path]?.kind === 'viewer', { contextBound, value });
            const options = constraint.kind === 'static' ? constraint.options : constraint.kind === 'dynamic'
                ? await ports.resolveOptions(field, resolved.input, request, readInputFieldSelectedValues(field, value)) : undefined;
            request.signal?.throwIfAborted();
            if (options && 'status' in options) {
                issues.push({ path: field.path, ...options });
                continue;
            }
            if (type) {
                const current = await ports.readInputType?.(field, request);
                request.signal?.throwIfAborted();
                if (!current || current.occurrenceId !== type.occurrenceId) {
                    issues.push({ path: field.path, status: 'unavailable', reasonCode: 'input_type_retired' }); continue;
                }
            }
            const admitted = validateInputFieldValue({ field, value, type, options,
                viewerPurpose: request.instance.bindings[field.path]?.kind === 'viewer', contextBound });
            if (admitted.status !== 'valid') issues.push(issue(admitted));
        }
        if (!issues.length) return resolved;
        const status = (['denied', 'invalid', 'unavailable'] as const).find(status => issues.some(issue => issue.status === status))!;
        return { status, fields: issues };
    } };
}
