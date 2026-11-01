import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const CodexAppServerTextTurnInputSchema = lazySchema(() => z
  .object({
    type: z.literal('text'),
    text: z.string(),
    textElements: z.array(z.unknown()).optional(),
  })
  .passthrough());

export const CodexAppServerImageTurnInputSchema = lazySchema(() => z
  .object({
    type: z.literal('image'),
    url: z.string().min(1),
  })
  .passthrough());

export const CodexAppServerLocalImageTurnInputSchema = lazySchema(() => z
  .object({
    type: z.literal('localImage'),
    path: z.string().min(1),
  })
  .passthrough());

export const CodexAppServerSkillTurnInputSchema = lazySchema(() => z
  .object({
    type: z.literal('skill'),
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .passthrough());

export const CodexAppServerMentionTurnInputSchema = lazySchema(() => z
  .object({
    type: z.literal('mention'),
    name: z.string().min(1),
    path: z.string().min(1).startsWith('plugin://'),
  })
  .passthrough());

export const CodexAppServerTurnInputItemSchema = lazySchema(() => z.discriminatedUnion('type', [
  CodexAppServerTextTurnInputSchema,
  CodexAppServerImageTurnInputSchema,
  CodexAppServerLocalImageTurnInputSchema,
  CodexAppServerSkillTurnInputSchema,
  CodexAppServerMentionTurnInputSchema,
]));
export type CodexAppServerTurnInputItem = z.infer<typeof CodexAppServerTurnInputItemSchema>;

export const CodexAppServerTurnInputSchema = lazySchema(() => z.array(CodexAppServerTurnInputItemSchema));
export type CodexAppServerTurnInput = z.infer<typeof CodexAppServerTurnInputSchema>;
