import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

export const MAX_AUTOMATION_EVENT_FILTER_CLAUSES = 32;
export const MAX_AUTOMATION_EVENT_FILTER_IN_VALUES = 64;
export const MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS = 256;
const MAX_AUTOMATION_EVENT_FILTER_POINTER_DEPTH = 32;

export const AUTOMATION_EVENT_DECIMAL_V1_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

const AutomationJsonStringV1Schema = lazyZodSchema(() => z.string().check(z.superRefine((value, context) => {
    if (value !== value.normalize('NFC')) {
      context.addIssue({ code: "custom", message: 'Filter strings must be NFC-normalized' });
    }
    if (Array.from(value).length > MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS) {
      context.addIssue({ code: "custom", message: 'Filter strings exceed the code-point limit' });
    }
  })));

const AutomationJsonScalarV1Schema = lazyZodSchema(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  AutomationJsonStringV1Schema,
]));
export type AutomationJsonScalarV1 = z.infer<typeof AutomationJsonScalarV1Schema>;

export const AutomationJsonPointerV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(1024), z.regex(/^\/(?:[^~]|~[01])*$/u, 'Expected one RFC 6901 JSON pointer'), z.superRefine((value, context) => {
    const segments = value.slice(1).split('/');
    if (segments.length > MAX_AUTOMATION_EVENT_FILTER_POINTER_DEPTH || segments.some((segment) => segment === '-')) {
      context.addIssue({ code: "custom", message: 'Filter pointers must address one bounded scalar leaf' });
    }
  })));
export type AutomationJsonPointerV1 = z.infer<typeof AutomationJsonPointerV1Schema>;

const AutomationEventFilterClauseV1Schema = lazyZodSchema(() => z.discriminatedUnion('op', [
  z.strictObject({
    op: z.enum(['gt', 'gte', 'lt', 'lte']),
    field: AutomationJsonPointerV1Schema,
    value: z.union([z.number(), AutomationJsonStringV1Schema.check(z.regex(AUTOMATION_EVENT_DECIMAL_V1_PATTERN))]),
  }),
  z.strictObject({
    op: z.literal('eq'),
    field: AutomationJsonPointerV1Schema,
    value: AutomationJsonScalarV1Schema,
  }),
  z.strictObject({
    op: z.literal('in'),
    field: AutomationJsonPointerV1Schema,
    values: z.array(AutomationJsonScalarV1Schema).check(z.minLength(1), z.maxLength(MAX_AUTOMATION_EVENT_FILTER_IN_VALUES), z.superRefine((values, context) => {
        const canonicalValues = values.map((value) => createCanonicalJsonSigningInput(value));
        if (new Set(canonicalValues).size !== canonicalValues.length) {
          context.addIssue({ code: "custom", message: 'Filter in-values must be unique' });
        }
      })),
  }),
]));
export type AutomationEventFilterClauseV1 = z.infer<typeof AutomationEventFilterClauseV1Schema>;

export const AutomationEventFilterV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  all: z.array(AutomationEventFilterClauseV1Schema).check(z.minLength(1), z.maxLength(MAX_AUTOMATION_EVENT_FILTER_CLAUSES)),
}));
export type AutomationEventFilterV1 = z.infer<typeof AutomationEventFilterV1Schema>;
