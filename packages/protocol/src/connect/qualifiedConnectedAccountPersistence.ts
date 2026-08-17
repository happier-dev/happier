import {
  defineProtocolObject,
  defineProtocolString,
} from '../plugins/actions/jsonSchemaValidation.js';
import {
  PluginContributionIdentityV1Schema,
} from '../plugins/contributionIdentity.js';

export const QualifiedConnectedAccountIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: 256,
  pattern: '^(?!\\s)[\\s\\S]*\\S$',
});

export const QualifiedConnectedAccountRefSchema = defineProtocolObject({
  service: PluginContributionIdentityV1Schema,
  accountId: QualifiedConnectedAccountIdSchema,
}, { policy: 'closed' });

/** Canonical portable JSON Schema projection of the qualified account ref. */
export const QualifiedConnectedAccountRefJsonSchema = QualifiedConnectedAccountRefSchema.jsonSchema;

export type QualifiedConnectedAccountRef = ReturnType<typeof QualifiedConnectedAccountRefSchema.parse>;
