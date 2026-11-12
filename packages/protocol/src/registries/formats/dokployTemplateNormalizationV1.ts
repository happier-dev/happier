import { parse as parseToml } from 'smol-toml';
import { parseDocument, stringify } from 'yaml';
import { DeploymentTemplateV1Schema, DeploymentTemplateSecretProfileV1Schema, type DeploymentTemplateSecretProfileV1 } from '../../plugins/contributions/deploymentTemplates.js';
import { normalizeComposeTemplateV1, templateRecordV1, type NormalizedComposeTemplateV1, type TemplateDiagnosticV1 } from './composeTemplateNormalizationV1.js';
import { DeploymentComposePublicFilesV1Schema } from '../../deployments/storedAppInputV1.js';

type Binding = { expression: string; profile?: DeploymentTemplateSecretProfileV1; default?: string; domain?: true };

/** Interpret the declarative Dokploy dialect; helpers become host-owned secret
 * profiles, never evaluated code. Common Compose admission remains the owner. */
export function normalizeDokployTemplateV1(input: Parameters<typeof normalizeComposeTemplateV1>[0] & Readonly<{ template: string; templateId?: string }>): NormalizedComposeTemplateV1 {
  const diagnostics: TemplateDiagnosticV1[] = [];
  const issue = (field: string, reason: string) => diagnostics.push({ field, reason });
  let template: Record<string, unknown>;
  let document: Record<string, unknown>;
  try {
    template = parseToml(input.template);
    const yaml = parseDocument(input.document, { uniqueKeys: true, merge: true });
    if (yaml.errors.length) throw new Error('invalid_yaml');
    document = templateRecordV1(yaml.toJS()) ?? {};
  } catch {
    return { state: 'needs_review', ignored: false, diagnostics: [{ field: 'template', reason: 'invalid_template_document' }] };
  }
  const variables = templateRecordV1(template.variables) ?? {};
  const config = templateRecordV1(template.config) ?? {};
  for (const key of Object.keys(config)) if (!['domains', 'env', 'mounts'].includes(key)) issue(`config.${key}`, 'unsupported_configuration');
  const jwtHelper = /^\$\{jwt:([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)\}$/;
  const payloadVariables = new Set(input.templateId === 'supabase' ? Object.values(variables).flatMap(value => {
    const match = typeof value === 'string' ? jwtHelper.exec(value) : null;
    return match ? [match[2]!] : [];
  }) : []);
  const bindings = new Map<string, Binding>();
  const resolving = new Set<string>();
  const reference = (key: string) => '${' + key + '}';
  const bind = (key: string, raw: unknown): Binding => {
    const prior = bindings.get(key);
    if (prior) return prior;
    if (resolving.has(key)) { issue(`variables.${key}`, 'cyclic_variable'); return { expression: reference(key) }; }
    resolving.add(key);
    let result: Binding = { expression: reference(key) };
    if (typeof raw !== 'string') issue(`variables.${key}`, 'unsupported_variable');
    else {
      const jwt = input.templateId === 'supabase' ? jwtHelper.exec(raw) : null;
      const hashes = input.templateId === 'supabase' && /\$\{hash:\d+\}/.test(raw) ? [...raw.matchAll(/\$\{hash:(\d+)\}/g)] : [];
      const helper = /^\$\{(password|base64|username|uuid|domain)(?::(\d+))?\}$/.exec(raw);
      const alias = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
      if (jwt) {
        const signing = bind(jwt[1]!, variables[jwt[1]!]);
        const rawPayload = variables[jwt[2]!];
        try {
          if (!signing.profile || signing.profile.kind === 'jwt-hs256' || typeof rawPayload !== 'string') throw new Error('unsupported_jwt');
          const payload: unknown = JSON.parse(rawPayload.replace(/\$\{timestamps:([^}]+)\}/g, (_whole, date: string) => {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date)) throw new Error('unsupported_timestamp');
            const timestamp = Date.parse(date) / 1000;
            if (!Number.isSafeInteger(timestamp)) throw new Error('unsupported_timestamp');
            return String(timestamp);
          }));
          result.profile = DeploymentTemplateSecretProfileV1Schema.parse({ kind: 'jwt-hs256', secretKey: signing.expression.slice(2, -1), payload });
        } catch { issue(`variables.${key}`, 'unsupported_helper'); }
      } else if (hashes.length) {
        const parts: (string | number)[] = []; let offset = 0;
        for (const hash of hashes) {
          if (hash.index! > offset) parts.push(raw.slice(offset, hash.index));
          const characters = Number(hash[1]);
          if (!Number.isSafeInteger(characters) || characters < 1) issue(`variables.${key}`, 'unsupported_helper');
          parts.push(characters); offset = hash.index! + hash[0].length;
        }
        if (offset < raw.length) parts.push(raw.slice(offset));
        if (parts.some(part => typeof part === 'string' && part.includes('${'))) issue(`variables.${key}`, 'unsupported_helper');
        const count = parts.length === 1 ? parts[0] : undefined;
        result.profile = typeof count === 'number' && count % 2 === 0
          ? { kind: 'hex-bytes', bytes: count / 2 } : { kind: 'hex-characters', parts };
      } else if (alias && alias[1] !== key && Object.hasOwn(variables, alias[1]!)) result = bind(alias[1]!, variables[alias[1]!]);
      else if (helper) {
        const size = helper[2] === undefined ? undefined : Number(helper[2]);
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 1)) issue(`variables.${key}`, 'unsupported_helper');
        else if (helper[1] === 'password') result.profile = { kind: 'lowercase-alphanumeric-characters', characters: size ?? 16 };
        else if (helper[1] === 'base64') result.profile = { kind: 'base64-bytes', bytes: size ?? 32 };
        else if (size !== undefined) issue(`variables.${key}`, 'unsupported_helper');
        else if (helper[1] === 'username') result.profile = { kind: 'lowercase-username' };
        else if (helper[1] === 'uuid') result.profile = { kind: 'uuid-v4' };
        else result.domain = true;
      } else if (alias && Object.hasOwn(variables, alias[1]!)) result = bind(alias[1]!, variables[alias[1]!]);
      else if (payloadVariables.has(key)) { /* Payload is consumed only by its typed JWT profile. */ }
      else if (/\$\{[^}]*:|\$\{(?:jwt|hash|randomPort|timestamp|timestamps|timestampms|email)\}/.test(raw)) issue(`variables.${key}`, 'unsupported_helper');
      else if (raw.includes('${')) {
        if ([...raw.matchAll(/\$\{([^}]+)\}/g)].some(match => !Object.hasOwn(variables, match[1]!))) issue(`variables.${key}`, 'unsupported_helper');
        result.expression = expand(raw);
      }
      else result.default = raw;
    }
    resolving.delete(key);
    bindings.set(key, result);
    return result;
  };
  const expand = (value: string): string => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, key: string) =>
    Object.hasOwn(variables, key) ? bind(key, variables[key]).expression : whole);
  for (const [key, value] of Object.entries(variables)) bind(key, value);
  const fileVariables = new Map(bindings);
  let environment = templateRecordV1(config.env);
  if (Array.isArray(config.env)) {
    environment = {};
    for (const [index, entry] of config.env.entries()) {
      const equals = typeof entry === 'string' ? entry.indexOf('=') : -1;
      if (typeof entry !== 'string' || equals < 1) { issue(`config.env.${index}`, 'unsupported_environment'); continue; }
      environment[entry.slice(0, equals)] = entry.slice(equals + 1);
    }
  } else if (config.env !== undefined && !environment) issue('config.env', 'unsupported_environment');
  const replacements = new Map<string, string>();
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (typeof value !== 'string') { issue(`config.env.${key}`, 'unsupported_environment'); continue; }
    const variableReference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (variableReference && Object.hasOwn(variables, variableReference[1]!)) replacements.set(key, expand(value));
    else if (/^\$\{(?:password|base64|username|uuid)(?::\d+)?\}$/.test(value)) {
      replacements.set(key, bind(key, value).expression);
    } else if (value.includes('${')) {
      if ([...value.matchAll(/\$\{([^}]+)\}/g)].some(match => !Object.hasOwn(variables, match[1]!))) issue(`config.env.${key}`, 'unsupported_helper');
      replacements.set(key, expand(value));
    }
    else { bindings.set(key, { expression: reference(key), default: value }); replacements.set(key, reference(key)); }
  }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (whole: string, key: string) => replacements.get(key) ?? whole);
    if (Array.isArray(value)) return value.map(rewrite);
    const record = templateRecordV1(value);
    if (record) for (const [key, entry] of Object.entries(record)) record[key] = rewrite(entry);
    return value;
  };
  rewrite(document);
  const services = templateRecordV1(document.services) ?? {};
  // Dokploy keeps Compose in code/ and its generated files in sibling files/.
  // Stored Compose owns one contained project root, so preserve both subtrees
  // there without turning a vendor file into a volume or injecting env values.
  for (const service of Object.values(services)) {
    const record = templateRecordV1(service);
    if (!Array.isArray(record?.volumes)) continue;
    record.volumes = record.volumes.map((value: unknown) => {
      if (typeof value === 'string') return value.replace(/^\.\.\/files\//, './files/');
      const mount = templateRecordV1(value);
      if (typeof mount?.source === 'string') mount.source = mount.source.replace(/^\.\.\/files\//, './files/');
      return value;
    });
  }
  const publicFiles: NonNullable<Parameters<typeof normalizeComposeTemplateV1>[0]['publicFiles']> = [];
  const domains: NonNullable<Parameters<typeof normalizeComposeTemplateV1>[0]['declaredDomains']>[number][] = [];
  if (config.domains !== undefined && !Array.isArray(config.domains)) issue('config.domains', 'invalid_domains');
  for (const [index, raw] of (Array.isArray(config.domains) ? config.domains : []).entries()) {
    const domain = templateRecordV1(raw);
    if (!domain || !Object.keys(domain).length) continue;
    const key = typeof domain.host === 'string' ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(domain.host)?.[1] : undefined;
    if (!key || !bindings.get(key)?.domain || typeof domain.serviceName !== 'string' || typeof domain.port !== 'number') {
      issue(`config.domains.${index}`, 'unsupported_domain'); continue;
    }
    for (const field of Object.keys(domain)) if (!['serviceName', 'port', 'host', 'path'].includes(field)) issue(`config.domains.${index}.${field}`, 'unsupported_configuration');
    domains.push({ key, service: domain.serviceName, containerPort: domain.port, ...(typeof domain.path === 'string' ? { path: domain.path } : {}) });
  }
  if (config.mounts !== undefined && !Array.isArray(config.mounts)) issue('config.mounts', 'invalid_mounts');
  for (const [index, raw] of (Array.isArray(config.mounts) ? config.mounts : []).entries()) {
    const mount = templateRecordV1(raw);
    if (!mount || !Object.keys(mount).length) continue;
    const field = `config.mounts.${index}`;
    if (typeof mount.filePath === 'string' && mount.filePath.includes('${')) { issue(field, 'unresolved_file_variable'); continue; }
    const path = typeof mount.filePath === 'string' ? `files/${mount.filePath.replace(/^\/+/, '')}` : '';
    if (!DeploymentComposePublicFilesV1Schema.safeParse([{ path, content: '' }]).success) {
      issue(field, 'unsafe_mount_path'); continue;
    }
    if (typeof mount.content !== 'string') { issue(field, 'unsupported_inline_file'); continue; }
    const content = expand(mount.content).replace(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (whole: string, key: string) => fileVariables.get(key)?.default ?? whole);
    const inlineSecret = [...mount.content.matchAll(/(?<!\$)\$\{(password|base64|username|uuid)(?::([^}]*))?\}/g)]
      .some(match => match[2] !== undefined || !bindings.has(match[1]!));
    if (inlineSecret || [...bindings].some(([key, binding]) => binding.profile && content.includes(reference(key)))) {
      issue(field, 'secret_content_requires_binding'); continue;
    }
    if (content.includes('${')) { issue(field, 'unresolved_file_variable'); continue; }
    publicFiles.push({ path, content });
  }
  const normalized = normalizeComposeTemplateV1({ ...input, document: stringify(document), declaredDomains: domains, publicFiles });
  diagnostics.push(...normalized.diagnostics);
  if (normalized.state !== 'ready' || diagnostics.length) return { state: 'needs_review', ignored: normalized.ignored, diagnostics };
  const app = normalized.app;
  for (const variable of app.variables) {
    const binding = bindings.get(variable.key);
    if (binding?.profile) {
      variable.secret = true;
      variable.required = true;
      app.generatedSecrets.push({ key: variable.key, label: variable.key, purpose: variable.key, profile: binding.profile });
    } else if (binding?.default !== undefined) variable.default = binding.default;
    if (binding?.domain && !variable.valueFrom) issue(`variables.${variable.key}`, 'unresolved_domain_reference');
  }
  const parsed = DeploymentTemplateV1Schema.safeParse(app);
  if (!parsed.success) for (const error of parsed.error.issues) issue(error.path.map(String).join('.'), 'invalid_descriptor');
  return parsed.success && !diagnostics.length ? { ...normalized, app: parsed.data } : { state: 'needs_review', ignored: normalized.ignored, diagnostics };
}
