import type { DeploymentTemplateV1, DeploymentTemplateSecretProfileV1, StoredAppPresetInputV1,
    DeploymentEnvironmentContentV1, EnvironmentVariableBindingV1, DeploymentTemplateCapacityReviewV1, DeploymentTemplateInstantiateInputV1 } from '@happier-dev/deployment-protocol';
import { prepareDeploymentTemplateAdditionV1 } from './prepareDeploymentTemplateAdditionV1.js';

type TemplateRef = Extract<StoredAppPresetInputV1['definition'], { from: 'catalogApp' }>['templateRef'];
export type DeploymentTemplateInstantiationPreparationInputV1 = Readonly<{
    template: DeploymentTemplateV1; templateRef: TemplateRef; intent?: DeploymentTemplateInstantiateInputV1['intent'];
    /** Parsed by P41's source syntax owner, never a separately interpreted template language. */
    source: Record<string, unknown>;
    current?: Readonly<{ content: DeploymentEnvironmentContentV1; source: Record<string, unknown>; publicFiles?: DeploymentTemplateV1['compose']['publicFiles'];
        baseline?: Readonly<{ templateRef: TemplateRef; source: Record<string, unknown> }> & Pick<DeploymentTemplateV1['compose'], 'publicFiles'> }>;
    bindings: StoredAppPresetInputV1['bindings']; connectTo?: Readonly<{ service: string }>;
    /** Bindings consumed alongside this Add reserve names without copying their custody. */
    reservedVariableNames?: readonly string[];
    replace?: readonly string[]; domainBindings?: Readonly<NonNullable<DeploymentTemplateInstantiateInputV1['domainBindings']>>;
    volumeBindings?: Readonly<NonNullable<DeploymentTemplateInstantiateInputV1['volumeBindings']>>;
    /** Selected optional companions; every other declared companion leaves the source. */
    companions?: Readonly<NonNullable<DeploymentTemplateInstantiateInputV1['companions']>>;
    /** One finite receiver sampler snapshot; absent facts remain unknown. */
    targetResources?: Readonly<{ sampledAt: number; memoryBytes?: number }>;
}>;
export type PreparedDeploymentTemplateInstantiationV1 = Readonly<{
    document: string; profiles: string[]; services: string[]; primaryService?: string;
    bindings: EnvironmentVariableBindingV1[];
    connectToServices: string[];
    generatedSecrets: Readonly<{ name: string; phase: 'build' | 'runtime'; key: string; profile: DeploymentTemplateSecretProfileV1 }>[];
    domains: (DeploymentTemplateV1['domains'][number] & { hostname: string })[];
    capacity: DeploymentTemplateCapacityReviewV1;
    template: Omit<NonNullable<DeploymentEnvironmentContentV1['template']>, 'definition'>;
}> & Pick<DeploymentTemplateV1['compose'], 'publicFiles'>;
export class DeploymentTemplatePreparationErrorV1 extends Error {
    constructor(readonly code: string, readonly details?: Readonly<{ key: string }>) {
        super(details ? `${code}: ${JSON.stringify(details.key)}` : code);
    }
}
function refuse(code: string, details?: Readonly<{ key: string }>): never {
    throw new DeploymentTemplatePreparationErrorV1(code, details);
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : refuse('template_needs_review');
}
function equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
/** Undefined represents a missing JSON property, so upstream removals stay removals. */
function mergePinnedSource(baseline: unknown, current: unknown, selected: unknown, conflict: string): unknown {
    if (equal(current, baseline)) return selected;
    if (equal(selected, baseline) || equal(current, selected)) return current;
    if (baseline && current && selected && typeof baseline === 'object' && typeof current === 'object'
        && typeof selected === 'object' && !Array.isArray(baseline) && !Array.isArray(current) && !Array.isArray(selected)) {
        const before = record(baseline), local = record(current), next = record(selected);
        return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(next)])].flatMap(key => {
            const value = mergePinnedSource(before[key], local[key], next[key], conflict);
            return value === undefined ? [] : [[key, value]];
        }));
    }
    return refuse(conflict);
}
function environment(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!Array.isArray(value)) return { ...record(value) };
    const entries = value.map(item => {
        if (typeof item !== 'string') return refuse('template_needs_review');
        const separator = item.indexOf('=');
        return separator < 0 ? [item, null] : [item.slice(0, separator), item.slice(separator + 1)];
    });
    return Object.fromEntries(entries);
}

/** A reviewed mount name changes the Compose source and the retained backup inventory together. */
function prepareVolumeBindings(input: DeploymentTemplateInstantiationPreparationInputV1): DeploymentTemplateInstantiationPreparationInputV1 {
    if (!input.volumeBindings?.length) return input;
    const names = new Map<string, string>();
    const declared = new Set(input.template.volumes.map(volume => volume.id));
    for (const binding of input.volumeBindings) {
        if (!declared.has(binding.templateVolumeId) || names.has(binding.templateVolumeId)) {
            return refuse('template_needs_review');
        }
        names.set(binding.templateVolumeId, binding.source);
    }
    const source = structuredClone(input.source);
    const rename = (name: string) => names.get(name) ?? name;
    if (source.volumes !== undefined) {
        const definitions: Record<string, unknown> = {};
        for (const [name, definition] of Object.entries(record(source.volumes))) {
            const selected = rename(name);
            if (Object.hasOwn(definitions, selected) && !equal(definitions[selected], definition)) return refuse('template_resource_conflict');
            definitions[selected] = definition;
        }
        source.volumes = definitions;
    }
    for (const value of Object.values(record(source.services))) {
        const service = record(value);
        if (Array.isArray(service.volumes)) service.volumes = service.volumes.map(mount => {
            if (typeof mount === 'string') {
                const separator = mount.indexOf(':');
                return separator < 0 ? mount : `${rename(mount.slice(0, separator))}${mount.slice(separator)}`;
            }
            const entry = record(mount);
            return typeof entry.source === 'string' ? { ...entry, source: rename(entry.source) } : entry;
        });
    }
    return { ...input, source, template: { ...input.template,
        volumes: input.template.volumes.map(volume => ({ ...volume, id: rename(volume.id) })) } };
}

/** Applies the reviewed companion choice once, before naming or merging: an unselected companion's services
 * leave the source, a selected one joins the service selection and its exports replace the same-named ones. */
function prepareCompanions(input: DeploymentTemplateInstantiationPreparationInputV1): DeploymentTemplateInstantiationPreparationInputV1 {
    const declared = input.template.companions ?? [];
    const selected = new Set(input.companions ?? []);
    const unknown = [...selected].find(id => !declared.some(companion => companion.id === id));
    if (unknown !== undefined) return refuse('template_companion_unknown', { key: unknown });
    if (!declared.length) return input;
    const services = { ...record(input.source.services) };
    let exports = input.template.exports;
    const chosenServices: string[] = [];
    for (const companion of declared) {
        if (!selected.has(companion.id)) {
            for (const service of companion.services) delete services[service];
            continue;
        }
        chosenServices.push(...companion.services);
        if (companion.exports) exports = { ...exports, ...companion.exports };
    }
    const { companions: _declared, ...template } = input.template;
    return { ...input, source: { ...input.source, services }, template: { ...template,
        compose: { ...template.compose, services: template.compose.services.length
            ? [...template.compose.services, ...chosenServices] : template.compose.services },
        ...(exports ? { exports } : {}) } };
}

/** Add-only/metadata composition needs no historical source; replacing an existing service does. */
export function resolveDeploymentTemplateInstantiationBaselineRefV1(
    input: Pick<DeploymentTemplateInstantiationPreparationInputV1, 'templateRef' | 'source' | 'current' | 'intent'>,
): TemplateRef | undefined {
    if (input.intent === 'add') return undefined;
    const current = input.current;
    const recorded = current?.content.template?.templateRef;
    if (!current || !recorded || recorded.sourceId !== input.templateRef.sourceId || recorded.itemId !== input.templateRef.itemId) return undefined;
    const currentServices = record(current.source.services);
    return Object.keys(record(input.source.services)).some(service => Object.hasOwn(currentServices, service)) ? recorded : undefined;
}

/** One inert plan for preview/apply. P41 admits the output; Actions alone create refs and write content. */
export function prepareDeploymentTemplateInstantiationV1(input: DeploymentTemplateInstantiationPreparationInputV1): PreparedDeploymentTemplateInstantiationV1 {
    input = prepareDeploymentTemplateAdditionV1(prepareVolumeBindings(prepareCompanions(input)));
    const { template } = input;
    const source = structuredClone(input.source);
    const declaredServices = record(source.services);
    const selectedServices = template.compose.services.length ? template.compose.services : Object.keys(declaredServices);
    const referencedServices = [...selectedServices, ...(template.compose.primaryService ? [template.compose.primaryService] : []),
        ...(template.health ?? []).map(health => health.service), ...(template.data ? [template.data.service] : []),
        ...template.domains.map(domain => domain.service), ...template.volumes.map(volume => volume.service),
        ...template.variables.flatMap(variable => variable.sites.map(site => site.service)),
        ...Object.values(template.exports ?? {}).map(output => output.service)];
    if (referencedServices.some(service => !Object.hasOwn(declaredServices, service))) return refuse('template_needs_review');
    const recorded = resolveDeploymentTemplateInstantiationBaselineRefV1(input);
    const upgrading = recorded !== undefined;
    const baseline = upgrading ? input.current?.baseline : undefined;
    if (upgrading && !baseline) return refuse('template_source_unavailable');
    if (baseline && !equal(baseline.templateRef, recorded)) return refuse('template_changed');
    const document = input.current ? structuredClone(input.current.source) : {};
    const fileMap = (files: DeploymentTemplateV1['compose']['publicFiles']) => Object.fromEntries((files ?? []).map(file => [file.path, file.content]));
    const currentDefinition = input.current?.content.definition;
    const currentFiles = input.current?.publicFiles ?? (currentDefinition?.kind === 'stored' ? currentDefinition.publicFiles : undefined);
    const selectedFiles = fileMap(template.compose.publicFiles);
    const incumbentFiles = fileMap(currentFiles);
    let mergedFiles: Record<string, unknown>;
    if (baseline) mergedFiles = record(mergePinnedSource(fileMap(baseline.publicFiles), incumbentFiles, selectedFiles, 'template_resource_conflict'));
    else {
        for (const [path, content] of Object.entries(selectedFiles)) {
            if (Object.hasOwn(incumbentFiles, path) && incumbentFiles[path] !== content) return refuse('template_resource_conflict');
        }
        mergedFiles = { ...incumbentFiles, ...selectedFiles };
    }
    const publicFiles = Object.entries(mergedFiles).map(([path, content]) => ({ path,
        content: typeof content === 'string' ? content : refuse('template_resource_conflict') }));
    for (const key of new Set([...Object.keys(source), ...Object.keys(baseline?.source ?? {})])) {
        const value = source[key];
        if (baseline) {
            const merged = mergePinnedSource(baseline.source[key], document[key], value,
                key === 'services' ? 'template_service_conflict' : 'template_resource_conflict');
            if (merged === undefined) delete document[key];
            else document[key] = merged;
            continue;
        }
        if (['services', 'volumes', 'networks', 'configs', 'secrets'].includes(key)) {
            const incumbent = document[key] === undefined ? {} : record(document[key]);
            const addition = record(value);
            for (const name of Object.keys(addition)) {
                if (Object.hasOwn(incumbent, name) && (key === 'services' || !equal(incumbent[name], addition[name]))) {
                    return refuse(key === 'services' ? 'template_service_conflict' : 'template_resource_conflict');
                }
            }
            document[key] = { ...incumbent, ...addition };
        } else {
            if (Object.hasOwn(document, key) && !equal(document[key], value)) return refuse('template_resource_conflict');
            document[key] = value;
        }
    }
    const replacements = new Set(input.replace ?? []);
    const declaredDomains = new Set(template.domains.map(domain => domain.key));
    const unknownDomain = input.domainBindings?.find(binding => !declaredDomains.has(binding.templateDomainId));
    if (unknownDomain) return refuse('template_domain_unknown', { key: unknownDomain.templateDomainId });
    const domains = template.domains.flatMap(domain => {
        const selected = input.domainBindings?.find(binding => binding.templateDomainId === domain.key);
        if (!selected) return domain.required ? refuse('template_domain_required') : [];
        // The existing own-server Domain route and probe contract is HTTP only.
        if (domain.protocol === 'tcp') return refuse('template_needs_review');
        // Literal DNS labels only: IDNs arrive as punycode, never URL syntax or Caddy placeholders.
        if (/[^a-z0-9.-]/.test(selected.hostname)
            || selected.hostname.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
            return refuse('template_needs_review');
        }
        return [{ ...domain, hostname: selected.hostname }];
    });
    const variables = new Map(template.variables.map(variable => [variable.key, variable]));
    if (input.bindings.some(binding => !variables.has(binding.name))) return refuse('template_binding_unknown');
    const bindings: EnvironmentVariableBindingV1[] = [];
    let generatedSecrets: PreparedDeploymentTemplateInstantiationV1['generatedSecrets'] = [];
    for (const variable of template.variables) {
        let selected = input.bindings.find(binding => binding.name === variable.key)
            ?? (upgrading ? input.current?.content.bindings.find((binding): binding is EnvironmentVariableBindingV1 =>
                binding.purpose === 'variable' && binding.name === variable.key) : undefined);
        if (variable.valueFrom) {
            const domain = domains.find(domain => domain.key === variable.valueFrom?.domainKey);
            if (domain) {
                const path = domain.path ?? '';
                const value = variable.valueFrom.kind === 'domainUrl' ? `${domain.protocol}://${domain.hostname}${path}` : domain.hostname;
                selected = { purpose: 'variable', phase: 'runtime', name: variable.key, source: { kind: 'value', value } };
            }
        }
        if (!selected && variable.default !== undefined) selected = { purpose: 'variable', name: variable.key,
            phase: 'runtime', source: { kind: 'value', value: variable.default } };
        if (!selected) {
            if (variable.required) return refuse('template_variable_required');
            continue;
        }
        if (selected.source.kind !== 'generated' && variable.secret && selected.source.kind !== 'secret') return refuse('template_secret_reference_required');
        const selection = selected;
        const incumbent = input.current?.content.bindings.find(binding => binding.purpose === 'variable'
            && binding.phase === selection.phase && binding.name === selection.name);
        if (incumbent && (selected.source.kind === 'generated' || !equal(incumbent.source, selected.source))
            && !replacements.has(variable.key)) return refuse('template_binding_conflict');
        if (selected.source.kind === 'generated') {
            const generatedKey = selected.source.key;
            const generated = template.generatedSecrets.find(generated => generated.key === generatedKey && generated.key === variable.key);
            if (!generated) return refuse('template_generator_undeclared', { key: generatedKey });
            generatedSecrets.push({ name: selected.name, phase: selected.phase, key: generated.key, profile: generated.profile });
            continue;
        }
        bindings.push({ ...selected, source: selected.source });
    }
    // Descriptors permit one dependency level: save independent secrets before deriving JWTs.
    // Existing Saved Secret overrides need the confidential acquisition owner before derivation.
    const independent = generatedSecrets.filter(secret => secret.profile.kind !== 'jwt-hs256');
    const signingKeys = new Set(independent.map(secret => secret.phase + ':' + secret.key));
    const derived = generatedSecrets.filter(secret => secret.profile.kind === 'jwt-hs256');
    for (const secret of derived) {
        if (secret.profile.kind === 'jwt-hs256' && !signingKeys.has(secret.phase + ':' + secret.profile.secretKey)) {
            return refuse('template_needs_review', { key: secret.key, dependency: secret.profile.secretKey });
        }
    }
    generatedSecrets = [...independent, ...derived];
    if (input.connectTo) {
        const services = record(document.services);
        const name = input.connectTo.service;
        const app = { ...record(services[name]) };
        if (name === template.data?.service) return refuse('template_needs_review');
        const env = environment(app.environment);
        const outputs = new Map<string, string>();
        for (const output of Object.values(template.exports ?? {})) for (const [key, value] of Object.entries(output.env ?? {})) {
            if (outputs.has(key) && outputs.get(key) !== value) return refuse('template_needs_review');
            outputs.set(key, value);
        }
        for (const [key, value] of outputs) {
            if (Object.hasOwn(env, key) && env[key] !== value && !replacements.has(key)) return refuse('template_binding_conflict');
            env[key] = value;
        }
        app.environment = env;
        if (template.data) {
            const dependency = template.data.service;
            app.depends_on = app.depends_on === undefined ? [dependency] : Array.isArray(app.depends_on)
                ? [...new Set([...app.depends_on, dependency])]
                : { ...record(app.depends_on), [dependency]: record(app.depends_on)[dependency] ?? { condition: 'service_started' } };
        }
        services[name] = app;
    }
    const current = input.current?.content.definition;
    const selectors = current?.kind === 'repository' ? current.compose : current;
    const profiles = [...new Set([...(selectors?.profiles ?? []), ...template.compose.profiles])];
    const services = selectors && selectors.services.length === 0 ? []
        : [...new Set([...(selectors?.services ?? []), ...selectedServices])];
    const primaryService = selectors?.primaryService ?? template.compose.primaryService;
    const capacity: DeploymentTemplateCapacityReviewV1 = [];
    for (const resource of ['memoryBytes', 'freeDiskBytes'] as const) {
        const minimumBytes = template.minimumResources?.[resource];
        if (minimumBytes === undefined) continue;
        // The Machine sampler observes host memory. It does not identify the
        // Docker data filesystem, so a home/root disk is never substituted.
        const observedBytes = resource === 'memoryBytes' ? input.targetResources?.memoryBytes ?? null : null;
        capacity.push({ resource, minimumBytes, observedBytes,
            observedAt: observedBytes === null ? null : input.targetResources!.sampledAt,
            state: observedBytes === null ? 'unknown' : observedBytes < minimumBytes ? 'shortfall' : 'meetsMinimum' });
    }
    const previousTemplate = input.current?.content.template;
    const mergedServices = record(document.services);
    const replacedServices = new Set(selectedServices);
    const retainMetadata = <T extends { service: string }>(entries: readonly T[] | undefined) =>
        (entries ?? []).filter(entry => !replacedServices.has(entry.service) && Object.hasOwn(mergedServices, entry.service));
    const data = [...retainMetadata(previousTemplate?.data), ...(template.data ? [template.data] : [])];
    const health = [...retainMetadata(previousTemplate?.health), ...(template.health ?? [])];
    const volumes = [...retainMetadata(previousTemplate?.volumes), ...template.volumes];
    const templateServices = [...new Set([...(previousTemplate?.services ?? []), ...selectedServices])]
        .filter(service => Object.hasOwn(mergedServices, service));
    return { connectToServices: input.current ? Object.keys(record(input.current.source.services)) : [], document: JSON.stringify(document), ...(publicFiles.length ? { publicFiles } : {}), profiles, services, ...(primaryService ? { primaryService } : {}), bindings, generatedSecrets, domains, capacity,
        template: { templateRef: input.templateRef, services: templateServices,
            ...(health.length ? { health } : {}),
            ...(volumes.length ? { volumes } : {}),
            ...(data.length ? { data } : {}), ...(template.exports ? { exports: template.exports } : {}),
            ...(template.loginFields ? { loginFields: template.loginFields } : {}), ...(template.firstRunSetup ? { firstRunSetup: template.firstRunSetup } : {}) } };
}
