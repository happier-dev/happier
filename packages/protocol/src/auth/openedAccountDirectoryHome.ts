import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  AccountDirectoryHomeEntryV1Schema,
  AccountDirectoryHomeLabelV1Schema,
} from './accountDirectory.js';

/**
 * Client-opened form of an Account Directory Home. The wire entry stays opaque
 * until the authenticated client has opened its private label.
 */
export const OpenedAccountDirectoryHomeEntryV1Schema = lazyZodSchema(() => z.pipe(
  z.transform((value, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      context.issues.push({ code: 'custom', message: 'Expected an opened Account Directory Home entry', input: context.value });
      return z.NEVER;
    }
    const entry = value as Record<string, unknown>;
    const label = AccountDirectoryHomeLabelV1Schema.safeParse(entry.label);
    if (!label.success) {
      context.issues.push({ code: 'custom', message: 'Expected an opened Account Directory Home label', input: entry.label });
      return z.NEVER;
    }
    // Reuse the wire entry's complete structural and descriptor invariant
    // without allowing the opened shape to become a wire representation.
    return {
      ...entry,
      label: {
        content: { t: 'plain' as const, v: label.data },
        recipientEnvelope: null,
      },
    };
  }),
  z.pipe(AccountDirectoryHomeEntryV1Schema, z.transform((entry, context) => {
    if (entry.label?.content.t !== 'plain') {
      context.issues.push({ code: 'custom', message: 'Opened Account Directory Home label must be plain', input: entry.label });
      return z.NEVER;
    }
    return { ...entry, label: entry.label.content.v };
  })),
));

export type OpenedAccountDirectoryHomeEntryV1 = z.infer<typeof OpenedAccountDirectoryHomeEntryV1Schema>;
