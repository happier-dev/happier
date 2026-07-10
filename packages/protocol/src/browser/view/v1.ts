import { z } from 'zod';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';

export const BrowserViewStateV1Schema = z.enum(['idle', 'loading', 'ready', 'failed', 'unsupported']);
export type BrowserViewStateV1 = z.infer<typeof BrowserViewStateV1Schema>;

export const BrowserPlatformV1Schema = z.enum(['web', 'desktop', 'ios', 'android']);
export type BrowserPlatformV1 = z.infer<typeof BrowserPlatformV1Schema>;

export const BrowserViewLoadingStateV1Schema = z.enum(['idle', 'loading', 'ready', 'failed']);
export type BrowserViewLoadingStateV1 = z.infer<typeof BrowserViewLoadingStateV1Schema>;

export const BrowserViewV1Schema = z
  .object({
    viewId: z.string().trim().min(1).max(256),
    browserSessionId: z.string().trim().min(1).max(256),
    target: BrowserViewTargetV1Schema,
    state: BrowserViewStateV1Schema,
    platform: BrowserPlatformV1Schema,
    currentUrl: BrowserHttpUrlV1Schema.nullable().optional(),
    currentUrlExpiresAt: z.number().int().nonnegative().nullable().optional(),
    pendingUrl: BrowserHttpUrlV1Schema.nullable().optional(),
    title: z.string().trim().max(512).nullable().optional(),
    faviconUrl: BrowserHttpUrlV1Schema.nullable().optional(),
    loadingState: BrowserViewLoadingStateV1Schema.optional(),
    loadingProgress: z.number().min(0).max(1).nullable().optional(),
    canGoBack: z.boolean().optional().default(false),
    canGoForward: z.boolean().optional().default(false),
    securityOrigin: BrowserHttpOriginV1Schema.nullable().optional(),
    lastError: z.string().trim().min(1).max(128).nullable().optional(),
    adapterKind: BrowserSemanticAdapterKindV1Schema.optional(),
    engineKind: BrowserRenderEngineKindV1Schema.exclude(['unavailable']).optional(),
    adapterCapabilities: BrowserAdapterCapabilitiesV1Schema.optional(),
    openerViewId: z.string().trim().min(1).max(256).nullable().optional(),
    errorCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type BrowserViewV1 = z.infer<typeof BrowserViewV1Schema>;
