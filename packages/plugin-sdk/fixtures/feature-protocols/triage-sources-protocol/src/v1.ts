import {
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

export const triageSourceDescriptorSchema = defineProtocolObject({
  kind: defineProtocolUnion([
    defineProtocolLiteral('issue'),
    defineProtocolLiteral('pull-request'),
  ]),
  label: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

export const triageSourceInspectionInputSchema = defineProtocolObject({
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

export const triageSourceDetailInputSchema = defineProtocolObject({
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

export const triageSourceInspectionResultSchema = defineProtocolObject({
  inspected: defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
  ]),
  entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

/** The one versioned source protocol shared by the independent triage examples. */
export const triageSourcesV1 = defineContributionProtocol({
  id: 'triage-sources',
  version: 1,
  descriptor: triageSourceDescriptorSchema,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: triageSourceInspectionResultSchema,
      action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    },
  },
  surfaces: {
    detail: {
      required: true,
      inputSchema: triageSourceDetailInputSchema,
      presentation: 'content',
    },
  },
});
