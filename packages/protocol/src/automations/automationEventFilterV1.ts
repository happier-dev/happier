import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

export const MAX_AUTOMATION_EVENT_FILTER_CLAUSES = 32;
export const MAX_AUTOMATION_EVENT_FILTER_IN_VALUES = 64;
export const MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS = 256;
const MAX_AUTOMATION_EVENT_FILTER_POINTER_DEPTH = 32;

const AutomationJsonScalarV1Schema = lazyZodSchema(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().superRefine((value, context) => {
    if (value !== value.normalize('NFC')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Filter strings must be NFC-normalized' });
    }
    if (Array.from(value).length > MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Filter strings exceed the code-point limit' });
    }
  }),
]));
export type AutomationJsonScalarV1 = z.infer<typeof AutomationJsonScalarV1Schema>;

export const AutomationJsonPointerV1Schema = lazyZodSchema(() => z.string().min(1).max(1024)
  .regex(/^\/(?:[^~]|~[01])*$/u, 'Expected one RFC 6901 JSON pointer')
  .superRefine((value, context) => {
    const segments = value.slice(1).split('/');
    if (segments.length > MAX_AUTOMATION_EVENT_FILTER_POINTER_DEPTH || segments.some((segment) => segment === '-')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Filter pointers must address one bounded scalar leaf' });
    }
  }));
export type AutomationJsonPointerV1 = z.infer<typeof AutomationJsonPointerV1Schema>;

const AutomationEventFilterClauseV1Schema = lazyZodSchema(() => z.discriminatedUnion('op', [
  z.object({
    op: z.literal('eq'),
    field: AutomationJsonPointerV1Schema,
    value: AutomationJsonScalarV1Schema,
  }).strict(),
  z.object({
    op: z.literal('in'),
    field: AutomationJsonPointerV1Schema,
    values: z.array(AutomationJsonScalarV1Schema)
      .min(1)
      .max(MAX_AUTOMATION_EVENT_FILTER_IN_VALUES)
      .superRefine((values, context) => {
        const canonicalValues = values.map((value) => createCanonicalJsonSigningInput(value));
        if (new Set(canonicalValues).size !== canonicalValues.length) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Filter in-values must be unique' });
        }
      }),
  }).strict(),
]));
export type AutomationEventFilterClauseV1 = z.infer<typeof AutomationEventFilterClauseV1Schema>;

export const AutomationEventFilterV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  all: z.array(AutomationEventFilterClauseV1Schema)
    .min(1)
    .max(MAX_AUTOMATION_EVENT_FILTER_CLAUSES),
}).strict());
export type AutomationEventFilterV1 = z.infer<typeof AutomationEventFilterV1Schema>;
