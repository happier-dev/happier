import type { DeploymentTemplateInstantiationPreparationInputV1 } from './prepareDeploymentTemplateInstantiationV1.js';

const resourceKinds = ['volumes', 'networks', 'configs', 'secrets'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/** Add allocates one namespace from the current Compose and bindings; preview and apply derive the same names. */
export function prepareDeploymentTemplateAdditionV1(input: DeploymentTemplateInstantiationPreparationInputV1): DeploymentTemplateInstantiationPreparationInputV1 {
    if (input.intent !== 'add' || !input.current) return input;
    const { template, current } = input;
    const services = Object.keys(object(input.source.services) ? input.source.services : {});
    const variables = template.variables.map(variable => variable.key);
    const occupiedServices = new Set(Object.keys(object(current.source.services) ? current.source.services : {}));
    const occupiedVariables = new Set(current.content.bindings.filter(binding => binding.purpose === 'variable').map(binding => binding.name));
    const resources = Object.fromEntries(resourceKinds.map(kind => [kind, Object.entries(object(input.source[kind]) ? input.source[kind] : {})
        // An external resource is intentionally shared; its existing name remains authoritative.
        .filter(([, value]) => !object(value) || !value.external).map(([name]) => name)])) as Record<typeof resourceKinds[number], string[]>;
    const occupiedResources = Object.fromEntries(resourceKinds.map(kind => [kind,
        new Set(Object.keys(object(current.source[kind]) ? current.source[kind] : {}))])) as Record<typeof resourceKinds[number], Set<string>>;
    const available = (ordinal: number) => services.every(name => !occupiedServices.has(ordinal === 1 ? name : `${name}-${ordinal}`))
        && variables.every(name => !occupiedVariables.has(ordinal === 1 ? name : `${name}_${ordinal}`))
        && resourceKinds.every(kind => resources[kind].every(name => !occupiedResources[kind].has(ordinal === 1 ? name : `${name}-${ordinal}`)));
    if (available(1)) return input;
    let ordinal = 2;
    while (!available(ordinal)) ordinal++;
    const serviceNames = new Map(services.map(name => [name, `${name}-${ordinal}`]));
    const variableNames = new Map(variables.map(name => [name, `${name}_${ordinal}`]));
    const resourceNames = Object.fromEntries(resourceKinds.map(kind => [kind,
        new Map(resources[kind].map(name => [name, `${name}-${ordinal}`]))])) as Record<typeof resourceKinds[number], Map<string, string>>;
    const service = (name: string) => serviceNames.get(name) ?? name;
    const variable = (name: string) => variableNames.get(name) ?? name;
    const interpolate = (value: string) => value.replace(/\$\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?=[:}?+\-])|([A-Za-z_][A-Za-z0-9_]*))/g,
        (match, braced: string | undefined, bare: string | undefined) => braced ? '${' + variable(braced) : bare ? '$' + variable(bare) : match);
    const connectionHost = (value: string) => {
        // Keep credentials/interpolation byte-for-byte; only a URI's host names a Compose service.
        return value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@]*@)?)([^/:?#]+)(?=[:/?#]|$)/,
            (_match, prefix: string, host: string) => `${prefix}${service(host)}`);
    };
    const strings = (value: unknown): unknown => typeof value === 'string' ? interpolate(value)
        : Array.isArray(value) ? value.map(strings) : object(value)
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, strings(entry)])) : value;
    const renameKeys = (value: unknown, names: Map<string, string>) => object(value)
        ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [names.get(key) ?? key, entry])) : value;
    const references = (value: unknown, names: Map<string, string>, short: (value: string) => string = value => names.get(value) ?? value) =>
        Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? short(entry)
            : object(entry) && typeof entry.source === 'string' ? { ...entry, source: names.get(entry.source) ?? entry.source } : entry)
            : renameKeys(value, names);
    const source = Object.fromEntries(Object.entries(input.source).map(([key, value]) => [key, strings(value)]));
    for (const kind of resourceKinds) {
        const definitions = source[kind];
        if (object(definitions)) source[kind] = Object.fromEntries(Object.entries(definitions).map(([name, value]) => [
            resourceNames[kind].get(name) ?? name,
            resourceNames[kind].has(name) && object(value) && typeof value.name === 'string'
                ? { ...value, name: `${value.name}-${ordinal}` } : value,
        ]));
    }
    if (object(source.services)) source.services = Object.fromEntries(Object.entries(source.services).map(([name, value]) => {
        if (!object(value)) return [service(name), value];
        const rewritten = { ...value };
        if (Array.isArray(rewritten.depends_on)) rewritten.depends_on = rewritten.depends_on.map(name => typeof name === 'string' ? service(name) : name);
        else if (object(rewritten.depends_on)) rewritten.depends_on = renameKeys(rewritten.depends_on, serviceNames);
        for (const field of ['network_mode', 'pid', 'ipc']) {
            const reference = rewritten[field];
            if (typeof reference === 'string' && reference.startsWith('service:')) rewritten[field] = `service:${service(reference.slice(8))}`;
        }
        if (object(rewritten.extends) && !rewritten.extends.file && typeof rewritten.extends.service === 'string') {
            rewritten.extends = { ...rewritten.extends, service: service(rewritten.extends.service) };
        }
        const shortReference = (entry: string, names: Map<string, string>) => {
            const separator = entry.indexOf(':');
            return separator < 0 ? names.get(entry) ?? entry : `${names.get(entry.slice(0, separator)) ?? entry.slice(0, separator)}${entry.slice(separator)}`;
        };
        for (const field of ['links', 'volumes_from']) if (Array.isArray(rewritten[field])) {
            rewritten[field] = rewritten[field].map(entry => typeof entry === 'string' ? shortReference(entry, serviceNames) : entry);
        }
        for (const kind of resourceKinds) if (rewritten[kind] !== undefined) {
            rewritten[kind] = references(rewritten[kind], resourceNames[kind], entry => shortReference(entry, resourceNames[kind]));
        }
        if (typeof rewritten.container_name === 'string') rewritten.container_name = `${rewritten.container_name}-${ordinal}`;
        if (object(rewritten.environment)) rewritten.environment = Object.fromEntries(Object.entries(rewritten.environment)
            .map(([key, entry]) => [key, typeof entry === 'string' ? connectionHost(entry) : entry]));
        else if (Array.isArray(rewritten.environment)) rewritten.environment = rewritten.environment.map(entry => {
            if (typeof entry !== 'string') return entry;
            const separator = entry.indexOf('=');
            return separator < 0 ? entry : `${entry.slice(0, separator + 1)}${connectionHost(entry.slice(separator + 1))}`;
        });
        return [service(name), rewritten];
    }));
    const data = template.data ? { ...template.data, service: service(template.data.service),
        ...(template.data.variables ? { variables: Object.fromEntries(Object.entries(template.data.variables).map(([key, value]) => [key, variable(value)])) } : {}),
        ...(template.data.logicalBackup ? { logicalBackup: { ...template.data.logicalBackup,
            ...(template.data.logicalBackup.database ? { database: variable(template.data.logicalBackup.database) } : {}),
            ...(template.data.logicalBackup.username ? { username: variable(template.data.logicalBackup.username) } : {}),
            ...(template.data.logicalBackup.path ? { path: interpolate(template.data.logicalBackup.path) } : {}),
        } } : {}) } : undefined;
    return { ...input, source, template: { ...template,
        compose: { ...template.compose, services: template.compose.services.map(service),
            ...(template.compose.primaryService ? { primaryService: service(template.compose.primaryService) } : {}) },
        variables: template.variables.map(entry => ({ ...entry, key: variable(entry.key),
            sites: entry.sites.map(site => ({ ...site, service: service(site.service) })) })),
        generatedSecrets: template.generatedSecrets.map(entry => ({ ...entry, key: variable(entry.key) })),
        domains: template.domains.map(entry => ({ ...entry, service: service(entry.service) })),
        volumes: template.volumes.map(entry => ({ ...entry, id: resourceNames.volumes.get(entry.id) ?? entry.id, service: service(entry.service) })),
        ...(template.health ? { health: template.health.map(entry => ({ ...entry, service: service(entry.service) })) } : {}),
        ...(data ? { data } : {}),
        ...(template.exports ? { exports: Object.fromEntries(Object.entries(template.exports).map(([key, entry]) => [key, { ...entry,
            service: service(entry.service), ...(entry.env ? { env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, connectionHost(interpolate(value))])) } : {}),
        }])) } : {}),
        ...(template.loginFields ? { loginFields: { password: variable(template.loginFields.password),
            ...(template.loginFields.username ? { username: variable(template.loginFields.username) } : {}) } } : {}),
    }, bindings: input.bindings.map(binding => binding.purpose === 'variable' ? { ...binding, name: variable(binding.name),
        ...(binding.source.kind === 'generated' ? { source: { ...binding.source, key: variable(binding.source.key) } } : {}) } : binding),
    ...(input.replace ? { replace: input.replace.map(variable) } : {}) };
}
