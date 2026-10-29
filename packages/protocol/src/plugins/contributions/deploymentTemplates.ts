import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploymentComposeSelectorsV1Schema } from '../../deployments/storedAppInputV1.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';

const text = () => z.string().check(z.minLength(1));
const key = () => z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u));
const port = () => z.number().check(z.int(), z.minimum(1), z.maximum(65535));
const positive = () => z.number().check(z.int(), z.positive());

/** Host-owned CSPRNG profiles, never executable author code or supplied seeds. */
export const DeploymentTemplateSecretProfileV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('base64url-32-bytes') }),
  z.strictObject({ kind: z.literal('hex-32-bytes') }),
  z.strictObject({ kind: z.literal('uuid-v4') }),
  z.strictObject({ kind: z.literal('lowercase-username') }),
  z.strictObject({ kind: z.literal('alphanumeric-characters'), characters: positive() }),
  z.strictObject({ kind: z.literal('lowercase-alphanumeric-characters'), characters: positive() }),
  z.strictObject({ kind: z.literal('hex-bytes'), bytes: positive() }),
  z.strictObject({ kind: z.literal('base64-bytes'), bytes: positive() }),
]));
export const DeploymentTemplateDataV1Schema = lazyZodSchema(() => z.strictObject({
  engine: z.enum(['postgres', 'mysql', 'mariadb', 'mongo', 'sqlite', 'redis']), version: z.optional(text()),
  service: text(), port: z.optional(port()),
  variables: z.optional(z.strictObject({ username: z.optional(key()), password: z.optional(key()), database: z.optional(key()) })),
  logicalBackup: z.optional(z.strictObject({
    adapter: z.enum(['postgres-v1', 'mysql-v1', 'mongo-v1', 'sqlite-v1']),
    database: z.optional(key()), path: z.optional(text()), username: z.optional(key()),
  })),
}).check(z.superRefine((data, context) => {
  const expected = { postgres: 'postgres-v1', mysql: 'mysql-v1', mariadb: 'mysql-v1', mongo: 'mongo-v1', sqlite: 'sqlite-v1', redis: null };
  if (data.logicalBackup && data.logicalBackup.adapter !== expected[data.engine]) {
    context.addIssue({ code: 'custom', path: ['logicalBackup', 'adapter'], message: 'Logical backup adapter must match the declared engine.' });
  }
})));

/** Wire epoch deployment-template.v1. Inert normalized registry data; no contribution registration. */
export const DeploymentTemplateV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1), title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema), category: z.optional(text()),
  documentationUrl: z.optional(z.string().check(z.url(), z.refine(value => {
    const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
  }))),
  compose: z.strictObject({ document: text(), ...DeploymentComposeSelectorsV1Schema.shape }),
  variables: z.array(z.strictObject({
    key: key(), label: PluginLocalizedStringV2Schema, help: z.optional(PluginLocalizedStringV2Schema),
    required: z.boolean(), valueKind: z.enum(['string', 'number', 'boolean']), secret: z.boolean(), default: z.optional(z.string()),
    valueFrom: z.optional(z.strictObject({ kind: z.enum(['domainUrl', 'domainHost']), domainKey: key() })),
    sites: z.array(z.strictObject({ service: text(), path: z.array(text()) })),
  })),
  generatedSecrets: z.array(z.strictObject({ key: key(), purpose: text(), label: PluginLocalizedStringV2Schema,
    profile: DeploymentTemplateSecretProfileV1Schema })),
  domains: z.array(z.strictObject({ key: key(), service: text(), containerPort: port(),
    protocol: z.enum(['http', 'https', 'tcp']), required: z.boolean(), path: z.optional(text()) })),
  volumes: z.array(z.strictObject({ id: text(), service: text(), target: text(), persistent: z.boolean(), backup: z.boolean(),
    consistency: z.optional(z.enum(['logicalDump', 'stopServiceDuringCopy'])), description: z.optional(PluginLocalizedStringV2Schema) })),
  health: z.optional(z.array(z.strictObject({ service: text(), participates: z.boolean() }))),
  minimumResources: z.optional(z.strictObject({ memoryBytes: z.optional(positive()), freeDiskBytes: z.optional(positive()),
    architectures: z.optional(z.array(z.enum(['amd64', 'arm64']))) })),
  data: z.optional(DeploymentTemplateDataV1Schema),
  exports: z.optional(z.record(text(), z.strictObject({ service: text(), port: port(), scheme: z.optional(text()),
    defaultExposure: z.enum(['internal', 'privateNetwork', 'public']), env: z.optional(z.record(key(), z.string())) }))),
  loginFields: z.optional(z.strictObject({ username: z.optional(key()), password: key() })),
  firstRunSetup: z.optional(z.literal(true)),
}).check(z.superRefine((template, context) => {
  const variables = new Map(template.variables.map(variable => [variable.key, variable]));
  const domains = new Set(template.domains.map(domain => domain.key));
  if (variables.size !== template.variables.length) context.addIssue({ code: 'custom', path: ['variables'], message: 'Variable keys must be unique.' });
  const generated = new Set<string>();
  for (const [index, secret] of template.generatedSecrets.entries()) {
    if (!variables.get(secret.key)?.secret || generated.has(secret.key)) context.addIssue({ code: 'custom', path: ['generatedSecrets', index, 'key'], message: 'Generated secrets require one declared secret variable.' });
    generated.add(secret.key);
  }
  for (const [index, variable] of template.variables.entries()) {
    if (variable.secret && variable.default !== undefined) context.addIssue({ code: 'custom', path: ['variables', index, 'default'], message: 'Secret variables cannot contain literal defaults.' });
    if (variable.valueFrom && (!domains.has(variable.valueFrom.domainKey) || variable.secret || generated.has(variable.key))) {
      context.addIssue({ code: 'custom', path: ['variables', index, 'valueFrom'], message: 'Domain variables require an actual domain and cannot be generated secrets.' });
    }
  }
  if (template.loginFields) {
    if (!variables.get(template.loginFields.password)?.secret) context.addIssue({ code: 'custom', path: ['loginFields', 'password'], message: 'Login password must name a declared secret variable.' });
    if (template.loginFields.username && !variables.has(template.loginFields.username)) context.addIssue({ code: 'custom', path: ['loginFields', 'username'], message: 'Login username must name a declared variable.' });
  }
  const dataRefs = [...Object.values(template.data?.variables ?? {}), template.data?.logicalBackup?.database, template.data?.logicalBackup?.username];
  if (dataRefs.some(ref => ref !== undefined && !variables.has(ref))) context.addIssue({ code: 'custom', path: ['data'], message: 'Data references must name declared variables.' });
})));
export type DeploymentTemplateV1 = z.infer<typeof DeploymentTemplateV1Schema>;
export type DeploymentTemplateDataV1 = z.infer<typeof DeploymentTemplateDataV1Schema>;
export type DeploymentTemplateSecretProfileV1 = z.infer<typeof DeploymentTemplateSecretProfileV1Schema>;
