import { parseDocument, stringify } from 'yaml';
import { DeploymentTemplateV1Schema, type DeploymentTemplateV1 } from '../../plugins/contributions/deploymentTemplates.js';

export type TemplateDiagnosticV1 = Readonly<{ field: string; reason: string }>;
export type NormalizedComposeTemplateV1 = Readonly<{ diagnostics: TemplateDiagnosticV1[]; ignored: boolean }> & (
  Readonly<{ state: 'ready'; app: DeploymentTemplateV1 }> | Readonly<{ state: 'needs_review' }>);
export const templateRecordV1 = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
type Variable = DeploymentTemplateV1['variables'][number];
type Profile = DeploymentTemplateV1['generatedSecrets'][number]['profile'];
type Domain = DeploymentTemplateV1['domains'][number];

export function readComposeTemplateHeaderV1(document: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of document.split(/\r?\n/)) {
    const match = /^#\s*([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (match) result[match[1]!] = match[2]!.trim();
  }
  return result;
}
export function templateGeneratorProfileV1(key: string): Profile | undefined {
  let match = /^SERVICE_PASSWORD_(?:(\d+)_)?(.+)$/.exec(key);
  if (match) return match[1] === undefined || match[1] === '64' ? { kind: 'alphanumeric-characters', characters: Number(match[1] ?? 32) } : undefined;
  if (/^SERVICE_USER_.+/.test(key)) return { kind: 'alphanumeric-characters', characters: 16 };
  match = /^SERVICE_(BASE64|REALBASE64)_(?:(\d+)_)?(.+)$/.exec(key);
  if (match && (match[2] === undefined || ['32', '64', '128'].includes(match[2]))) {
    const length = Number(match[2] ?? 32);
    return match[1] === 'BASE64' ? { kind: 'alphanumeric-characters', characters: length } : { kind: 'base64-bytes', bytes: length };
  }
  match = /^SERVICE_HEX_(32|64|128)_.+$/.exec(key);
  return match ? { kind: 'hex-bytes', bytes: Number(match[1]) / 2 } : undefined;
}
function routeKey(key: string): Readonly<{ alias: string; port?: number }> | undefined {
  const match = /^SERVICE_(?:URL|FQDN)_(.+?)(?:_(\d+))?$/.exec(key);
  if (!match) return undefined;
  return { alias: match[1]!, ...(match[2] ? { port: Number(match[2]) } : {}) };
}
function environmentEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap(entry => {
    if (typeof entry !== 'string') return [];
    const separator = entry.indexOf('=');
    return [[separator < 0 ? entry : entry.slice(0, separator), separator < 0 ? null : entry.slice(separator + 1)]];
  });
  return Object.entries(templateRecordV1(value) ?? {});
}
function evidencedPorts(service: Record<string, unknown>, header: Record<string, string>): number[] {
  const ports = new Set<number>();
  if (header.port && /^\d+$/.test(header.port)) ports.add(Number(header.port));
  for (const entry of [...(Array.isArray(service.expose) ? service.expose : []), ...(Array.isArray(service.ports) ? service.ports : [])]) {
    const target = templateRecordV1(entry)?.target ?? (typeof entry === 'number' ? entry : typeof entry === 'string' ? entry.split(':').at(-1)?.replace(/\/.*$/, '') : undefined);
    if (target !== undefined && /^\d+$/.test(String(target))) ports.add(Number(target));
  }
  return [...ports].filter(port => Number.isSafeInteger(port) && port > 0 && port <= 65535);
}

/** Only data translation happens here. The registry owner acquires bytes and
 * Plan 41 admits the resulting standard Compose document. */
export function normalizeComposeTemplateV1(input: Readonly<{ document: string; title: string; description?: string; category?: string; documentationUrl?: string }>): NormalizedComposeTemplateV1 {
  const diagnostics: TemplateDiagnosticV1[] = [];
  const issue = (field: string, reason: string) => diagnostics.push({ field, reason });
  const header = readComposeTemplateHeaderV1(input.document);
  if (header.env_file) issue('header.env_file', 'sidecar_file_requires_review');
  const parsed = parseDocument(input.document, { uniqueKeys: true, merge: true });
  let document: Record<string, unknown> = {};
  try {
    if (parsed.errors.length) throw new Error('invalid_yaml');
    document = templateRecordV1(parsed.toJS()) ?? {};
  } catch { issue('compose', 'invalid_yaml'); }
  const services = templateRecordV1(document.services) ?? {};
  if (!Object.keys(services).length) issue('compose.services', 'missing_services');
  const variables = new Map<string, Variable>();
  const generatedSecrets = new Map<string, DeploymentTemplateV1['generatedSecrets'][number]>();
  const domains = new Map<string, Domain>();
  const routeOwners = new Map<string, Domain>();
  const health: NonNullable<DeploymentTemplateV1['health']> = [];
  const volumes: DeploymentTemplateV1['volumes'] = [];
  const architectures = new Set<'amd64' | 'arm64'>();
  const ensureVariable = (key: string, site?: Variable['sites'][number], operator?: string): Variable => {
    const hasFallback = operator === '-' || operator === ':-';
    const required = !hasFallback && operator !== '+' && operator !== ':+';
    let variable = variables.get(key);
    if (!variable) {
      const profile = templateGeneratorProfileV1(key);
      // A Compose fallback belongs to its expression. A global binding would
      // override other sites and satisfy unrelated required expressions.
      variable = { key, label: key, required: required || profile !== undefined, valueKind: 'string', secret: profile !== undefined, sites: [] };
      const route = routeKey(key);
      const domain = route && routeOwners.get(route.alias);
      if (domain) variable.valueFrom = { kind: key.startsWith('SERVICE_FQDN_') ? 'domainHost' : 'domainUrl', domainKey: domain.key };
      variables.set(key, variable);
      if (profile) generatedSecrets.set(key, { key, purpose: key, label: key, profile });
      else if (key.startsWith('SERVICE_') && !routeKey(key)) issue(`variables.${key}`, 'unsupported_generator');
    } else if (required) variable.required = true;
    if (hasFallback && variable.secret) issue(`variables.${key}`, 'secret_default_requires_review');
    if (site && !variable.sites.some(prior => prior.service === site.service && JSON.stringify(prior.path) === JSON.stringify(site.path))) variable.sites.push(site);
    return variable;
  };
  // Establish route authority only from declarations, before scanning references.
  const declarations = new Map<string, Domain[]>();
  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = templateRecordV1(rawService);
    if (!service) { issue(`services.${serviceName}`, 'invalid_service'); continue; }
    for (const [key, value] of environmentEntries(service.environment)) {
      const route = routeKey(key);
      if (!route || value !== null && value !== undefined && value !== '') continue;
      const ports = route.port === undefined ? evidencedPorts(service, header) : [route.port];
      if (ports.length !== 1 || !Number.isSafeInteger(ports[0]) || ports[0]! < 1 || ports[0]! > 65535) { issue(`services.${serviceName}.environment.${key}`, 'ambiguous_domain_port'); continue; }
      const candidate: Domain = { key, service: serviceName, containerPort: ports[0]!, protocol: 'http', required: true };
      const group = declarations.get(route.alias) ?? [];
      group.push(candidate);
      declarations.set(route.alias, group);
    }
  }
  for (const [alias, group] of declarations) {
    const uniqueServices = new Set(group.map(domain => domain.service));
    const uniquePorts = new Set(group.map(domain => domain.containerPort));
    // A variable alias cannot establish a service owner. Repeated bare
    // declarations on different services need review; explicit references
    // consume the already-declared value and are not added to this group.
    const owner = uniquePorts.size === 1 && uniqueServices.size === 1 ? group[0] : undefined;
    if (owner) { routeOwners.set(alias, owner); domains.set(owner.key, owner); }
    else for (const domain of group) issue(`services.${domain.service}.environment.${domain.key}`, 'conflicting_domain_owner');
  }
  const scan = (value: unknown, service: string, path: string[]): unknown => {
    if (typeof value === 'string') return value.replace(/(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (matched: string, braced: string | undefined, operator: string | undefined, _fallback: string | undefined, bare: string | undefined) => {
        const key = braced ?? bare!;
        const route = routeKey(key);
        if (route && !routeOwners.has(route.alias)) issue(`services.${service}.${path.join('.')}`, 'unresolved_domain_reference');
        ensureVariable(key, { service, path }, operator);
        return bare ? '${' + key + '}' : matched;
      });
    if (Array.isArray(value)) return value.map((entry, index) => scan(entry, service, [...path, String(index)]));
    const record = templateRecordV1(value);
    if (record) for (const [key, entry] of Object.entries(record)) record[key] = scan(entry, service, [...path, key]);
    return value;
  };
  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = templateRecordV1(rawService);
    if (!service) continue;
    if ('exclude_from_hc' in service) { health.push({ service: serviceName, participates: service.exclude_from_hc !== true }); delete service.exclude_from_hc; }
    for (const [key, arch] of [['amd_only', 'amd64'], ['arm_only', 'arm64']] as const) {
      if (service[key] === true || header[key] === 'true') architectures.add(arch);
      delete service[key];
    }
    delete service.minversion;
    if (service.env_file !== undefined) issue(`services.${serviceName}.env_file`, 'sidecar_file_requires_review');
    const environment: Record<string, unknown> = {};
    for (const [key, value] of environmentEntries(service.environment)) {
      if (routeKey(key) && (value === null || value === undefined || value === '')) continue;
      if (value === null || value === undefined) {
        ensureVariable(key, { service: serviceName, path: ['environment', key] });
        environment[key] = '${' + key + '}';
      } else environment[key] = value;
    }
    if (service.environment !== undefined) service.environment = environment;
    if (Array.isArray(service.volumes)) service.volumes = service.volumes.flatMap((mount: unknown, index: number) => {
      const object = templateRecordV1(mount);
      if (object) {
        for (const marker of ['is_directory', 'isDirectory']) {
          if (object[marker] === true) issue(`services.${serviceName}.volumes.${index}.${marker}`, 'directory_source_requires_preparation');
          delete object[marker];
        }
        if ('content' in object) {
          const field = `services.${serviceName}.volumes.${index}`;
          const content = object.content;
          const target = object.target;
          const secretContent = typeof content === 'string' && /\$\{?SERVICE_(?:PASSWORD|USER|BASE64|REALBASE64|HEX)_/.test(content);
          if (typeof content !== 'string' || typeof target !== 'string' || !target.startsWith('/') || target.split('/').includes('..')) issue(field, 'unsupported_inline_file');
          else if (secretContent || object.secret === true || object.sensitive === true) issue(field, 'secret_content_requires_binding');
          else if (object.read_only === false || object.writable === true || object.mode === 'rw') issue(field, 'writable_content_requires_review');
          else {
            const configurations = templateRecordV1(document.configs) ?? {};
            document.configs = configurations;
            const serviceConfigs: unknown[] = Array.isArray(service.configs) ? service.configs : [];
            if (serviceConfigs.some(config => templateRecordV1(config)?.target === target)) issue(field, 'config_target_collision');
            else {
              const stem = `happier_${serviceName.replace(/[^A-Za-z0-9_-]/g, '_')}_${index}`;
              let id = stem;
              for (let suffix = 2; Object.hasOwn(configurations, id); suffix++) id = `${stem}_${suffix}`;
              configurations[id] = { content };
              serviceConfigs.push({ source: id, target, ...(object.mode !== undefined ? { mode: object.mode } : {}),
                ...(object.uid !== undefined ? { uid: object.uid } : {}), ...(object.gid !== undefined ? { gid: object.gid } : {}) });
              service.configs = serviceConfigs;
              return [];
            }
          }
          // The original dialect content remains visible for correction but is
          // never handed to Compose as an admitted file/bind declaration.
          return [];
        }
      }
      const source = object?.source ?? (typeof mount === 'string' ? mount.split(':')[0] : undefined);
      const target = object?.target ?? (typeof mount === 'string' ? mount.split(':')[1] : undefined);
      const named = typeof source === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) && object?.type !== 'bind';
      if (typeof source === 'string' && !named && !source.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(source) && !source.startsWith('~')) {
        issue(`services.${serviceName}.volumes.${index}.source`, 'sidecar_file_requires_review');
      }
      if (named && typeof target === 'string') {
        const definitions = templateRecordV1(document.volumes) ?? {};
        document.volumes = definitions;
        if (!Object.hasOwn(definitions, source)) definitions[source] = {};
        volumes.push({ id: source, service: serviceName, target, persistent: true, backup: true, consistency: 'stopServiceDuringCopy' });
      }
      return [mount];
    });
    scan(service, serviceName, []);
  }
  // Config interpolation is declared at each mounting service, so secret/public
  // variable identity is shared with ordinary Compose substitutions.
  const configs = templateRecordV1(document.configs);
  if (configs) for (const [id, raw] of Object.entries(configs)) {
    const config = templateRecordV1(raw);
    if (config && typeof config.content === 'string') {
      if (/\$\{?SERVICE_(?:PASSWORD|USER|BASE64|REALBASE64|HEX)_/.test(config.content)) issue(`configs.${id}.content`, 'secret_content_requires_binding');
      for (const [serviceName, rawService] of Object.entries(services)) {
        const service = templateRecordV1(rawService);
        if (Array.isArray(service?.configs) && service.configs.some(entry => entry === id || templateRecordV1(entry)?.source === id)) {
          config.content = scan(config.content, serviceName, ['configs', id, 'content']);
        }
      }
    } else if (config?.file !== undefined) issue(`configs.${id}.file`, 'sidecar_file_requires_review');
  }
  const documentationUrl = header.documentation ?? input.documentationUrl;
  const app = DeploymentTemplateV1Schema.safeParse({ schemaVersion: 1, title: input.title,
    ...((header.slogan ?? input.description) ? { description: header.slogan ?? input.description } : {}),
    ...((header.category ?? input.category) ? { category: header.category ?? input.category } : {}),
    ...(documentationUrl?.startsWith('https://') ? { documentationUrl } : {}),
    compose: { document: Object.keys(services).length ? stringify(document) : input.document, profiles: [], services: Object.keys(services),
      ...(Object.keys(services).length === 1 ? { primaryService: Object.keys(services)[0] } : {}) },
    variables: [...variables.values()], generatedSecrets: [...generatedSecrets.values()], domains: [...domains.values()], volumes,
    ...(health.length ? { health } : {}), ...(architectures.size ? { minimumResources: { architectures: [...architectures] } } : {}),
  });
  if (!app.success) for (const error of app.error.issues) issue(error.path.map(String).join('.'), 'invalid_descriptor');
  return app.success && diagnostics.length === 0 ? { state: 'ready', app: app.data, diagnostics, ignored: header.ignore === 'true' }
    : { state: 'needs_review', diagnostics, ignored: header.ignore === 'true' };
}
