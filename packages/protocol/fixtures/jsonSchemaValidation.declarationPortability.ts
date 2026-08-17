import {
  defineProtocolObject,
  defineProtocolString,
} from '../src/plugins/actions/jsonSchemaValidation.js';

export const DeclarationPortableStringSchema = defineProtocolString({
  minLength: 1,
  maxLength: 64,
});

export const DeclarationPortableNestedSchema = defineProtocolObject({
  id: DeclarationPortableStringSchema,
  label: defineProtocolString({ maxLength: 128 }),
}, { policy: 'closed' });
