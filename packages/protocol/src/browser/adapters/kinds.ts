import { z } from 'zod';

export const BrowserRenderEngineKindV1Schema = z.enum([
  'webIframe',
  'nativeWebView',
  'desktopWebView',
  'electronWebContentsView',
  'streamedSurface',
  'unavailable',
]);
export type BrowserRenderEngineKindV1 = z.infer<typeof BrowserRenderEngineKindV1Schema>;

export const BrowserSemanticAdapterKindV1Schema = z.enum([
  'localPreview',
  'hostedPlugin',
  'externalUrl',
  'chromiumSidecar',
  'streamedBrowserSurface',
  'simulatorPreview',
]);
export type BrowserSemanticAdapterKindV1 = z.infer<typeof BrowserSemanticAdapterKindV1Schema>;
