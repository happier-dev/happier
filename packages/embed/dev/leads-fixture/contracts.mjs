import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

const configuredOrigin = process.env.HAPPIER_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5199';
const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]*)$/.exec(configuredOrigin)?.[1];
if (!port || Number(port) > 65535) {
  throw new Error('HAPPIER_FIXTURE_ORIGIN must be http://127.0.0.1:<port> with a port from 1 to 65535.');
}
export const FIXTURE_ORIGIN = new URL(configuredOrigin).origin;
const text = () => defineProtocolString({ minLength: 1 });
export const recordAnalysisSchema = defineProtocolObject({
  leadId: text(), score: defineProtocolNumber({ minimum: 0, maximum: 100 }),
  summary: text(), nextStep: text(),
}, { policy: 'closed' });
export const updateStageSchema = defineProtocolObject({
  leadId: text(),
  stage: defineProtocolUnion([
    defineProtocolLiteral('new'), defineProtocolLiteral('contacted'),
    defineProtocolLiteral('qualified'), defineProtocolLiteral('won'), defineProtocolLiteral('lost'),
  ]),
}, { policy: 'closed' });
export const actionResultSchema = defineProtocolObject({
  leadId: text(), invocationId: text(),
}, { policy: 'closed' });

export const actionSchemas = { record_analysis: recordAnalysisSchema, update_stage: updateStageSchema };
