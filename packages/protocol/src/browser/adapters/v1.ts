import { z } from 'zod';

import { BrowserAutomationActionCapabilityMapV1Schema } from '../automation/v1.js';
import { BrowserContextKindV1Schema } from '../context/v1.js';
import { BrowserDiagnosticFidelityV1Schema } from '../diagnostics/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';
import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from './kinds.js';
export {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
  type BrowserRenderEngineKindV1,
  type BrowserSemanticAdapterKindV1,
} from './kinds.js';

export const BrowserAdapterNavigationCapabilitiesV1Schema = z
  .object({
    canNavigate: z.boolean().optional().default(false),
    canGoBack: z.boolean().optional().default(false),
    canGoForward: z.boolean().optional().default(false),
    canReload: z.boolean().optional().default(false),
    canStop: z.boolean().optional().default(false),
  })
  .strict();
export type BrowserAdapterNavigationCapabilitiesV1 = z.infer<
  typeof BrowserAdapterNavigationCapabilitiesV1Schema
>;

export const BrowserAdapterInputRoutingV1Schema = z.enum(['none', 'native', 'pmsControlSideband']);
export type BrowserAdapterInputRoutingV1 = z.infer<typeof BrowserAdapterInputRoutingV1Schema>;

const DiagnosticsFidelityByFamilySchema = z
  .object({
    console: BrowserDiagnosticFidelityV1Schema.optional(),
    pageError: BrowserDiagnosticFidelityV1Schema.optional(),
    network: BrowserDiagnosticFidelityV1Schema.optional(),
    elements: BrowserDiagnosticFidelityV1Schema.optional(),
    resources: BrowserDiagnosticFidelityV1Schema.optional(),
    storage: BrowserDiagnosticFidelityV1Schema.optional(),
    pageInfo: BrowserDiagnosticFidelityV1Schema.optional(),
    performance: BrowserDiagnosticFidelityV1Schema.optional(),
    screenshot: BrowserDiagnosticFidelityV1Schema.optional(),
    proxyTunnel: BrowserDiagnosticFidelityV1Schema.optional(),
  })
  .strict();

const DEFAULT_BROWSER_ADAPTER_NAVIGATION_CAPABILITIES: BrowserAdapterNavigationCapabilitiesV1 = {
  canNavigate: false,
  canGoBack: false,
  canGoForward: false,
  canReload: false,
  canStop: false,
};

export const BrowserAdapterCapabilitiesV1Schema = z
  .object({
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    supportedTargetKinds: z.array(BrowserViewTargetKindV1Schema).optional().default([]),
    supportedRenderEngines: z.array(BrowserRenderEngineKindV1Schema).optional().default([]),
    navigation: BrowserAdapterNavigationCapabilitiesV1Schema.optional().default(
      DEFAULT_BROWSER_ADAPTER_NAVIGATION_CAPABILITIES,
    ),
    diagnosticsFidelityByFamily: DiagnosticsFidelityByFamilySchema.optional().default({}),
    automationActions: BrowserAutomationActionCapabilityMapV1Schema.optional(),
    contextKinds: z.array(BrowserContextKindV1Schema).optional().default([]),
    inputRouting: BrowserAdapterInputRoutingV1Schema.optional().default('none'),
    supportsDownloads: z.boolean().optional().default(false),
    supportsUploads: z.boolean().optional().default(false),
    supportsPopups: z.boolean().optional().default(false),
    supportsPermissions: z.boolean().optional().default(false),
    supportsStreamingDisplay: z.boolean().optional().default(false),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
// NOTE: external URLs ARE rendered best-effort in the web `webIframe` engine (with the always-present
// open-in-system-browser escape for non-framable sites), so `externalUrl` legitimately advertises
// `webIframe`. The earlier guard rejecting that pairing contradicted the shipped iframe feature and
// forced the adapter capabilities to "unavailable", which disabled the address bar.
export type BrowserAdapterCapabilitiesV1 = z.infer<typeof BrowserAdapterCapabilitiesV1Schema>;
