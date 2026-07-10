import { z } from 'zod';

export const BrowserAutomationFidelityV1Schema = z.enum([
  'cdp',
  'nativeWebView',
  'injectedPage',
  'previewProxy',
  'streamedSurface',
  'webIframe',
  'unavailable',
]);
export type BrowserAutomationFidelityV1 = z.infer<typeof BrowserAutomationFidelityV1Schema>;
