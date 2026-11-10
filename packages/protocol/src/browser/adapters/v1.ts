import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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

export const BrowserAdapterNavigationCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    canNavigate: z._default(z.optional(z.boolean()), false),
    canGoBack: z._default(z.optional(z.boolean()), false),
    canGoForward: z._default(z.optional(z.boolean()), false),
    canReload: z._default(z.optional(z.boolean()), false),
    canStop: z._default(z.optional(z.boolean()), false),
  }));
export type BrowserAdapterNavigationCapabilitiesV1 = z.infer<
  typeof BrowserAdapterNavigationCapabilitiesV1Schema
>;

export const BrowserAdapterInputRoutingV1Schema = lazyZodSchema(() => z.enum(['none', 'native', 'pmsControlSideband']));
export type BrowserAdapterInputRoutingV1 = z.infer<typeof BrowserAdapterInputRoutingV1Schema>;

const DiagnosticsFidelityByFamilySchema = lazyZodSchema(() => z.strictObject({
    console: z.optional(BrowserDiagnosticFidelityV1Schema),
    pageError: z.optional(BrowserDiagnosticFidelityV1Schema),
    network: z.optional(BrowserDiagnosticFidelityV1Schema),
    elements: z.optional(BrowserDiagnosticFidelityV1Schema),
    resources: z.optional(BrowserDiagnosticFidelityV1Schema),
    storage: z.optional(BrowserDiagnosticFidelityV1Schema),
    pageInfo: z.optional(BrowserDiagnosticFidelityV1Schema),
    performance: z.optional(BrowserDiagnosticFidelityV1Schema),
    screenshot: z.optional(BrowserDiagnosticFidelityV1Schema),
    proxyTunnel: z.optional(BrowserDiagnosticFidelityV1Schema),
  }));

const DEFAULT_BROWSER_ADAPTER_NAVIGATION_CAPABILITIES: BrowserAdapterNavigationCapabilitiesV1 = {
  canNavigate: false,
  canGoBack: false,
  canGoForward: false,
  canReload: false,
  canStop: false,
};

export const BrowserAdapterCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    supportedTargetKinds: z._default(z.optional(z.array(BrowserViewTargetKindV1Schema)), []),
    supportedRenderEngines: z._default(z.optional(z.array(BrowserRenderEngineKindV1Schema)), []),
    navigation: z._default(z.optional(BrowserAdapterNavigationCapabilitiesV1Schema), DEFAULT_BROWSER_ADAPTER_NAVIGATION_CAPABILITIES),
    diagnosticsFidelityByFamily: z._default(z.optional(DiagnosticsFidelityByFamilySchema), {}),
    automationActions: z.optional(BrowserAutomationActionCapabilityMapV1Schema),
    contextKinds: z._default(z.optional(z.array(BrowserContextKindV1Schema)), []),
    inputRouting: z._default(z.optional(BrowserAdapterInputRoutingV1Schema), 'none'),
    supportsDownloads: z._default(z.optional(z.boolean()), false),
    supportsUploads: z._default(z.optional(z.boolean()), false),
    supportsPopups: z._default(z.optional(z.boolean()), false),
    supportsPermissions: z._default(z.optional(z.boolean()), false),
    supportsStreamingDisplay: z._default(z.optional(z.boolean()), false),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
// NOTE: external URLs ARE rendered best-effort in the web `webIframe` engine (with the always-present
// open-in-system-browser escape for non-framable sites), so `externalUrl` legitimately advertises
// `webIframe`. The earlier guard rejecting that pairing contradicted the shipped iframe feature and
// forced the adapter capabilities to "unavailable", which disabled the address bar.
export type BrowserAdapterCapabilitiesV1 = z.infer<typeof BrowserAdapterCapabilitiesV1Schema>;
