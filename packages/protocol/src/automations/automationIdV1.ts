import type { z } from 'zod';

import {
  defineProtocolString,
} from '../plugins/actions/protocolComposableSchema.js';

const HOST_IDENTIFIER_V1_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

/** @internal Shared bounded opaque host identifier used by Automation contracts. */
export const AutomationHostIdentifierV1Schema = defineProtocolString({
  minLength: 1,
  maxLength: 256,
  pattern: HOST_IDENTIFIER_V1_PATTERN.source,
});
/** Canonical Automation identity: bounded, opaque, and never normalized. */
export const AutomationIdV1Schema = AutomationHostIdentifierV1Schema;
export type AutomationIdV1 = ReturnType<typeof AutomationIdV1Schema.parse>;

export const AutomationHostIdentifierV1JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: HOST_IDENTIFIER_V1_PATTERN.source,
} as const;
