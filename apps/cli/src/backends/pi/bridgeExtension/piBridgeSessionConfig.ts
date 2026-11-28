import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

import { PiSharedControlConfigSchema } from '../sharedControl/piSharedControlProtocol';

export const PiBridgeToolDescriptorSchema = lazySchema(() => z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  call: z.object({
    toolName: z.string().min(1),
    actionId: z.string().min(1).nullable(),
  }).strict(),
}).strict());

export const PiBridgeSessionConfigSchema = lazySchema(() => z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  directTools: z.array(PiBridgeToolDescriptorSchema),
  promptAddition: z.string(),
  launch: z.object({
    filePath: z.string().min(1),
    argPrefix: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }).strict(),
  /** Present only for a native-TUI (shared local control) launch; RPC launches omit it. */
  sharedControl: PiSharedControlConfigSchema.optional(),
}).strict());

export type PiBridgeSessionConfig = z.infer<typeof PiBridgeSessionConfigSchema>;
