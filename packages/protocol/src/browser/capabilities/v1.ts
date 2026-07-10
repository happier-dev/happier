import { z } from 'zod';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import { BrowserCommandKindV1Schema } from '../control/v1.js';
import { BrowserEventKindV1Schema } from '../events/v1.js';

export const BrowserControlPlaneCapabilitiesV1Schema = z
  .object({
    supportedCommands: z.array(BrowserCommandKindV1Schema).optional().default([]),
    supportedEvents: z.array(BrowserEventKindV1Schema).optional().default([]),
    adapters: z.array(BrowserAdapterCapabilitiesV1Schema).optional().default([]),
    disabledReasons: z.array(z.string().trim().min(1).max(128)).optional().default([]),
  })
  .strict();
export type BrowserControlPlaneCapabilitiesV1 = z.infer<typeof BrowserControlPlaneCapabilitiesV1Schema>;
