import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';

export const BrowserViewStateV1Schema = lazyZodSchema(() => z.enum(['idle', 'loading', 'ready', 'failed', 'unsupported']));
export type BrowserViewStateV1 = z.infer<typeof BrowserViewStateV1Schema>;

export const BrowserPlatformV1Schema = lazyZodSchema(() => z.enum(['web', 'desktop', 'ios', 'android']));
export type BrowserPlatformV1 = z.infer<typeof BrowserPlatformV1Schema>;

export const BrowserViewLoadingStateV1Schema = lazyZodSchema(() => z.enum(['idle', 'loading', 'ready', 'failed']));
export type BrowserViewLoadingStateV1 = z.infer<typeof BrowserViewLoadingStateV1Schema>;

export const BrowserViewV1Schema = lazyZodSchema(() => z.strictObject({
    viewId: z.string().check(z.trim(), z.minLength(1)),
    browserSessionId: z.string().check(z.trim(), z.minLength(1)),
    target: BrowserViewTargetV1Schema,
    state: BrowserViewStateV1Schema,
    platform: BrowserPlatformV1Schema,
    currentUrl: z.optional(z.nullable(BrowserHttpUrlV1Schema)),
    currentUrlExpiresAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    pendingUrl: z.optional(z.nullable(BrowserHttpUrlV1Schema)),
    title: z.optional(z.nullable(z.string().check(z.trim()))),
    faviconUrl: z.optional(z.nullable(BrowserHttpUrlV1Schema)),
    loadingState: z.optional(BrowserViewLoadingStateV1Schema),
    loadingProgress: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(1)))),
    canGoBack: z._default(z.optional(z.boolean()), false),
    canGoForward: z._default(z.optional(z.boolean()), false),
    securityOrigin: z.optional(z.nullable(BrowserHttpOriginV1Schema)),
    lastError: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    adapterKind: z.optional(BrowserSemanticAdapterKindV1Schema),
    engineKind: z.optional(z.enum(BrowserRenderEngineKindV1Schema.options.filter((value): value is Exclude<(typeof BrowserRenderEngineKindV1Schema.options)[number], 'unavailable'> => !(['unavailable'] as readonly string[]).includes(value)))),
    adapterCapabilities: z.optional(BrowserAdapterCapabilitiesV1Schema),
    openerViewId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }));
export type BrowserViewV1 = z.infer<typeof BrowserViewV1Schema>;
