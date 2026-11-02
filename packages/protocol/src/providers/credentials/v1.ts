import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ProviderLocalIdSchema } from '../ids.js';
import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1, ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { normalizeProviderCredentialHeaderName, normalizeProviderQueryParameterName } from '../safety/headers.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';

export const ProviderCredentialFormatV1Schema = lazyZodSchema(() => z.union([
  z.literal('raw'),
  z.literal('bearer'),
  z.strictObject({ template: z.string().check(z.minLength(1), z.maxLength(256)) }).check(z.superRefine((value, ctx) => {
    if ((value.template.match(/\{secret\}/gu) ?? []).length !== 1 || /[\u0000-\u001f\u007f]/u.test(value.template)) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: 'Credential template must contain exactly one {secret} placeholder and no controls' });
    }
  })),
]));
export type ProviderCredentialFormatV1 = z.infer<typeof ProviderCredentialFormatV1Schema>;
export const ProviderCredentialFormatKindV1Schema = lazyZodSchema(() => z.enum(['raw', 'bearer', 'template']));
export type ProviderCredentialFormatKindV1 = z.infer<typeof ProviderCredentialFormatKindV1Schema>;

const CredentialHeaderNameSchema = lazyZodSchema(() => z.pipe(z.string(), z.transform((value, ctx) => {
  try { return normalizeProviderCredentialHeaderName(value); } catch (error) {
    ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential header name', input: ctx.value });
    return z.NEVER;
  }
})));
const CredentialQueryNameSchema = lazyZodSchema(() => z.pipe(z.string(), z.transform((value, ctx) => {
  try { return normalizeProviderQueryParameterName(value); } catch (error) {
    ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential query name', input: ctx.value });
    return z.NEVER;
  }
})));

export const ProviderCredentialDestinationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('httpHeader'),
    name: CredentialHeaderNameSchema,
    format: ProviderCredentialFormatV1Schema,
  }),
  z.strictObject({
    kind: z.literal('queryParam'),
    name: CredentialQueryNameSchema,
    format: ProviderCredentialFormatV1Schema,
  }),
]));
export type ProviderCredentialDestinationV1 = z.infer<typeof ProviderCredentialDestinationV1Schema>;

export const ProviderCredentialTransportV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderLocalIdSchema,
  protocols: z.array(ProviderWireProtocolSchema).check(z.minLength(1), z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
  uses: z.array(z.enum(['probe', 'runtime', 'management'])).check(z.minLength(1), z.maxLength(3)),
  destination: ProviderCredentialDestinationV1Schema,
  /** Required independent Saved Secret bindings, carried with this one transport. */
  additionalCredentials: z.optional(z.array(z.strictObject({
    slotId: ProviderLocalIdSchema,
    label: z.optional(PluginLocalizedStringV2Schema),
    destination: ProviderCredentialDestinationV1Schema,
  }))),
}).check(z.superRefine((value, ctx) => {
  if (new Set(value.protocols).size !== value.protocols.length) {
    ctx.addIssue({ code: 'custom', path: ['protocols'], message: 'Credential transport protocols must be unique' });
  }
  if (new Set(value.uses).size !== value.uses.length) {
    ctx.addIssue({ code: 'custom', path: ['uses'], message: 'Credential transport uses must be unique' });
  }
  const slots = new Set<string>();
  const destinationKey = (destination: ProviderCredentialDestinationV1) => `${destination.kind}\0${destination.kind === 'httpHeader' ? destination.name.toLowerCase() : destination.name}`;
  const destinations = new Set([destinationKey(value.destination)]);
  for (const [index, credential] of (value.additionalCredentials ?? []).entries()) {
    if (slots.has(credential.slotId)) ctx.addIssue({ code: 'custom', path: ['additionalCredentials', index, 'slotId'], message: 'Duplicate credential slot' });
    slots.add(credential.slotId);
    const key = destinationKey(credential.destination);
    if (destinations.has(key)) ctx.addIssue({ code: 'custom', path: ['additionalCredentials', index, 'destination'], message: 'Credential destinations must be distinct' });
    destinations.add(key);
  }
})));
export type ProviderCredentialTransport = z.infer<typeof ProviderCredentialTransportV1Schema>;
export type ProviderCredentialTransportV1 = ProviderCredentialTransport;

export function addProviderCredentialTransportIssues(
  transports: readonly ProviderCredentialTransportV1[],
  ctx: z.core.$RefinementCtx,
  pathPrefix: readonly (string | number)[] = ['transports'],
): void {
  const ids = new Set<string>();
  const destinations = new Set<string>();
  transports.forEach((transport, index) => {
    if (ids.has(transport.id)) ctx.addIssue({ code: 'custom', path: [...pathPrefix, index, 'id'], message: 'Duplicate transport id' });
    ids.add(transport.id);
    transport.additionalCredentials?.forEach((credential, credentialIndex) => {
      if (credential.slotId === 'apiKey') ctx.addIssue({ code: 'custom', path: [...pathPrefix, index, 'additionalCredentials', credentialIndex, 'slotId'], message: 'Companion credential must use an independent slot' });
    });
    for (const protocol of transport.protocols) {
      for (const use of transport.uses) {
        const format = typeof transport.destination.format === 'string' ? transport.destination.format : `template:${transport.destination.format.template}`;
        const destinationName = transport.destination.kind === 'httpHeader'
          ? transport.destination.name.toLowerCase()
          : transport.destination.name;
        const key = `${protocol}\0${use}\0${transport.destination.kind}\0${destinationName}\0${format}`;
        if (destinations.has(key)) ctx.addIssue({ code: 'custom', path: [...pathPrefix, index], message: 'Ambiguous credential transport' });
        destinations.add(key);
      }
    }
  });
}

export const ProviderApiKeyCredentialRequirementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('apiKey'),
  slotId: z._default(z.literal('apiKey'), 'apiKey'),
  required: z._default(z.boolean(), true),
  keyUrl: z.optional(ProviderHttpsUrlSchema),
  transports: z.array(ProviderCredentialTransportV1Schema).check(z.minLength(1), z.maxLength(16)),
}).check(z.superRefine((value, ctx) => {
  addProviderCredentialTransportIssues(value.transports, ctx);
})));
export type ProviderApiKeyCredentialRequirementV1 = z.infer<typeof ProviderApiKeyCredentialRequirementV1Schema>;

export function providerCredentialFormatKind(format: ProviderCredentialFormatV1): ProviderCredentialFormatKindV1 {
  return typeof format === 'string' ? format : 'template';
}
