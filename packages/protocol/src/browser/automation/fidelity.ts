import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const BrowserAutomationFidelityV1Schema = lazyZodSchema(() => z.enum([
  'cdp',
  'nativeWebView',
  'injectedPage',
  'previewProxy',
  'streamedSurface',
  'webIframe',
  'unavailable',
]));
export type BrowserAutomationFidelityV1 = z.infer<typeof BrowserAutomationFidelityV1Schema>;
