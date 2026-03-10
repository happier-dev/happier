import { z } from 'zod';

import { PromptPlacementV1Schema, type PromptPlacementV1 } from './promptPlacementV1.js';

export const PromptStackRefV1Schema = z.object({
  kind: z.enum(['doc', 'bundle']),
  artifactId: z.string().min(1),
});

export type PromptStackRefV1 = z.infer<typeof PromptStackRefV1Schema>;

export const PromptStackEditPolicyV1Schema = z.enum([
  'user_only',
  'agent_may_propose_requires_approval',
]);

export type PromptStackEditPolicyV1 = z.infer<typeof PromptStackEditPolicyV1Schema>;

export const PromptStackEntryV1Schema = z.object({
  id: z.string().min(1),
  ref: PromptStackRefV1Schema,
  enabled: z.boolean().default(true),
  placement: PromptPlacementV1Schema.default('system_append' satisfies PromptPlacementV1),
  maxChars: z.number().int().min(1).optional(),
  editPolicy: PromptStackEditPolicyV1Schema.default('user_only'),
});

export type PromptStackEntryV1 = z.infer<typeof PromptStackEntryV1Schema>;

export const PromptStacksV1Schema = z
  .object({
    v: z.literal(1).default(1),
    surfaces: z
      .object({
        coding: z.array(PromptStackEntryV1Schema).default([]),
        voice: z.array(PromptStackEntryV1Schema).default([]),
        profilesById: z.record(z.string(), z.array(PromptStackEntryV1Schema)).default({}),
      })
      .default({ coding: [], voice: [], profilesById: {} }),
  })
  .catch({ v: 1, surfaces: { coding: [], voice: [], profilesById: {} } });

export type PromptStacksV1 = z.infer<typeof PromptStacksV1Schema>;
