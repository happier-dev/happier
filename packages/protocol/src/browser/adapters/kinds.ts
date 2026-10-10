import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const BrowserRenderEngineKindV1Schema = lazyZodSchema(() => z.enum([
  'webIframe',
  'nativeWebView',
  'desktopWebView',
  'electronWebContentsView',
  'streamedSurface',
  'unavailable',
]));
export type BrowserRenderEngineKindV1 = z.infer<typeof BrowserRenderEngineKindV1Schema>;

export const BrowserSemanticAdapterKindV1Schema = lazyZodSchema(() => z.enum([
  'localPreview',
  'hostedPlugin',
  'externalUrl',
  'chromiumSidecar',
  'streamedBrowserSurface',
  'simulatorPreview',
]));
export type BrowserSemanticAdapterKindV1 = z.infer<typeof BrowserSemanticAdapterKindV1Schema>;
