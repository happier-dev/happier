import { z } from 'zod';

import { BrowserViewTargetV1Schema } from '../target/v1.js';

export const BrowserViewStateV1Schema = z.enum(['idle', 'loading', 'ready', 'failed', 'unsupported']);
export type BrowserViewStateV1 = z.infer<typeof BrowserViewStateV1Schema>;

export const BrowserPlatformV1Schema = z.enum(['web', 'desktop', 'ios', 'android']);
export type BrowserPlatformV1 = z.infer<typeof BrowserPlatformV1Schema>;

export const BrowserViewV1Schema = z
  .object({
    viewId: z.string().trim().min(1).max(256),
    browserSessionId: z.string().trim().min(1).max(256),
    target: BrowserViewTargetV1Schema,
    state: BrowserViewStateV1Schema,
    platform: BrowserPlatformV1Schema,
    errorCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type BrowserViewV1 = z.infer<typeof BrowserViewV1Schema>;
