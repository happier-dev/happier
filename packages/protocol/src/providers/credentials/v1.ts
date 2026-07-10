import { z } from 'zod';

import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { normalizeProviderCredentialHeaderName, normalizeProviderQueryParameterName } from '../safety/index.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';

export const ProviderCredentialFormatV1Schema = z.union([
  z.literal('raw'),
  z.literal('bearer'),
  z.object({ template: z.string().min(1).max(256) }).strict().superRefine((value, ctx) => {
    if ((value.template.match(/\{secret\}/gu) ?? []).length !== 1 || /[\u0000-\u001f\u007f]/u.test(value.template)) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: 'Credential template must contain exactly one {secret} placeholder and no controls' });
    }
  }),
]);
export type ProviderCredentialFormatV1 = z.infer<typeof ProviderCredentialFormatV1Schema>;
export const ProviderCredentialFormatKindV1Schema = z.enum(['raw', 'bearer', 'template']);
export type ProviderCredentialFormatKindV1 = z.infer<typeof ProviderCredentialFormatKindV1Schema>;

const CredentialHeaderNameSchema = z.string().transform((value, ctx) => {
  try { return normalizeProviderCredentialHeaderName(value); } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential header name' });
    return z.NEVER;
  }
});
const CredentialQueryNameSchema = z.string().transform((value, ctx) => {
  try { return normalizeProviderQueryParameterName(value); } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid credential query name' });
    return z.NEVER;
  }
});

export const ProviderCredentialDestinationV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('httpHeader'),
    name: CredentialHeaderNameSchema,
    format: ProviderCredentialFormatV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('queryParam'),
    name: CredentialQueryNameSchema,
    format: ProviderCredentialFormatV1Schema,
  }).strict(),
]);
export type ProviderCredentialDestinationV1 = z.infer<typeof ProviderCredentialDestinationV1Schema>;

export const ProviderCredentialTransportV1Schema = z.object({
  id: ProviderLocalIdSchema,
  protocols: z.array(ProviderWireProtocolSchema).min(1).max(4),
  uses: z.array(z.enum(['probe', 'runtime', 'management'])).min(1).max(3),
  destination: ProviderCredentialDestinationV1Schema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.protocols).size !== value.protocols.length) {
    ctx.addIssue({ code: 'custom', path: ['protocols'], message: 'Credential transport protocols must be unique' });
  }
  if (new Set(value.uses).size !== value.uses.length) {
    ctx.addIssue({ code: 'custom', path: ['uses'], message: 'Credential transport uses must be unique' });
  }
});
export type ProviderCredentialTransportV1 = z.infer<typeof ProviderCredentialTransportV1Schema>;

export function addProviderCredentialTransportIssues(
  transports: readonly ProviderCredentialTransportV1[],
  ctx: z.RefinementCtx,
  pathPrefix: readonly (string | number)[] = ['transports'],
): void {
  const ids = new Set<string>();
  const destinations = new Set<string>();
  transports.forEach((transport, index) => {
    if (ids.has(transport.id)) ctx.addIssue({ code: 'custom', path: [...pathPrefix, index, 'id'], message: 'Duplicate transport id' });
    ids.add(transport.id);
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

export const ProviderApiKeyCredentialRequirementV1Schema = z.object({
  kind: z.literal('apiKey'),
  slotId: z.literal('apiKey').default('apiKey'),
  required: z.boolean().default(true),
  keyUrl: ProviderHttpsUrlSchema.optional(),
  transports: z.array(ProviderCredentialTransportV1Schema).min(1).max(16),
}).strict().superRefine((value, ctx) => {
  addProviderCredentialTransportIssues(value.transports, ctx);
});
export type ProviderApiKeyCredentialRequirementV1 = z.infer<typeof ProviderApiKeyCredentialRequirementV1Schema>;

export function providerCredentialFormatKind(format: ProviderCredentialFormatV1): ProviderCredentialFormatKindV1 {
  return typeof format === 'string' ? format : 'template';
}
