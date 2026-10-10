import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';
import { BrowserPlatformV1Schema } from '../view/v1.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserAutomationControllerStateV1Schema } from '../automation/v1.js';

const BrowserEventBaseV1Schema = lazyZodSchema(() => z
  .object({
    eventId: z.string().trim().min(1).max(256),
    browserSessionId: z.string().trim().min(1).max(256),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict());

const BrowserViewEventBaseV1Schema = lazyZodSchema(() => BrowserEventBaseV1Schema.extend({
  viewId: z.string().trim().min(1).max(256),
  navigationGeneration: z.number().int().nonnegative().optional(),
}));

export const BrowserNavigationLoadingStateV1Schema = lazyZodSchema(() => z.enum(['idle', 'loading', 'ready', 'failed']));
export type BrowserNavigationLoadingStateV1 = z.infer<typeof BrowserNavigationLoadingStateV1Schema>;

export const BrowserEventKindV1Schema = lazyZodSchema(() => z.enum([
  'sessionCreated',
  'sessionClosed',
  'viewOpened',
  'viewClosed',
  'viewFocused',
  'targetChanged',
  'navigationStarted',
  'navigationCommitted',
  'navigationFinished',
  'navigationFailed',
  'navigationStateChanged',
  'controllerChanged',
  'titleChanged',
  'faviconChanged',
  'loadingProgressChanged',
  'permissionRequested',
  'downloadRequested',
  'popupRequested',
  'externalOpenRequested',
  'viewCrashed',
  'adapterUnavailable',
]));
export type BrowserEventKindV1 = z.infer<typeof BrowserEventKindV1Schema>;

export const BrowserSessionCreatedEventV1Schema = lazyZodSchema(() => BrowserEventBaseV1Schema.extend({
  kind: z.literal('sessionCreated'),
  profileId: z.string().trim().min(1).max(256),
}));

export const BrowserSessionClosedEventV1Schema = lazyZodSchema(() => BrowserEventBaseV1Schema.extend({
  kind: z.literal('sessionClosed'),
  reasonCode: z.string().trim().min(1).max(128).optional(),
}));

export const BrowserViewOpenedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('viewOpened'),
  target: BrowserViewTargetV1Schema,
  platform: BrowserPlatformV1Schema,
  currentUrl: BrowserHttpUrlV1Schema.optional(),
  currentUrlExpiresAt: z.number().int().nonnegative().optional(),
  adapterKind: BrowserSemanticAdapterKindV1Schema,
  engineKind: BrowserRenderEngineKindV1Schema.exclude(['unavailable']),
  adapterCapabilities: BrowserAdapterCapabilitiesV1Schema,
  openerViewId: z.string().trim().min(1).max(256).optional(),
}));

export const BrowserViewClosedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('viewClosed'),
  reasonCode: z.string().trim().min(1).max(128).optional(),
}));

export const BrowserViewFocusedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('viewFocused'),
}));

export const BrowserTargetChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('targetChanged'),
  target: BrowserViewTargetV1Schema,
  currentUrl: BrowserHttpUrlV1Schema.optional(),
}));

export const BrowserNavigationStartedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('navigationStarted'),
  pendingUrl: BrowserHttpUrlV1Schema,
}));

export const BrowserNavigationCommittedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('navigationCommitted'),
  currentUrl: BrowserHttpUrlV1Schema,
  securityOrigin: BrowserHttpOriginV1Schema.optional(),
}));

export const BrowserNavigationFinishedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('navigationFinished'),
  currentUrl: BrowserHttpUrlV1Schema.optional(),
}));

export const BrowserNavigationFailedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('navigationFailed'),
  failedUrl: BrowserHttpUrlV1Schema.optional(),
  errorCode: z.string().trim().min(1).max(128),
}));

export const BrowserNavigationStateChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('navigationStateChanged'),
  currentUrl: BrowserHttpUrlV1Schema.optional(),
  pendingUrl: BrowserHttpUrlV1Schema.optional(),
  title: z.string().trim().max(512).optional(),
  faviconUrl: BrowserHttpUrlV1Schema.optional(),
  loadingState: BrowserNavigationLoadingStateV1Schema,
  loadingProgress: z.number().min(0).max(1).optional(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  securityOrigin: BrowserHttpOriginV1Schema.optional(),
  lastError: z.string().trim().min(1).max(128).optional(),
}));

export const BrowserTitleChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('titleChanged'),
  title: z.string().trim().max(512),
}));

export const BrowserControllerChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('controllerChanged'),
  state: BrowserAutomationControllerStateV1Schema,
}));

export const BrowserFaviconChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('faviconChanged'),
  faviconUrl: BrowserHttpUrlV1Schema.optional(),
}));

export const BrowserLoadingProgressChangedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('loadingProgressChanged'),
  loadingProgress: z.number().min(0).max(1),
}));

export const BrowserPermissionRequestedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('permissionRequested'),
  permissionRequestId: z.string().trim().min(1).max(256),
  permissionKind: z.string().trim().min(1).max(128),
  origin: BrowserHttpOriginV1Schema.optional(),
}));

export const BrowserDownloadRequestedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('downloadRequested'),
  downloadRequestId: z.string().trim().min(1).max(256),
  url: BrowserHttpUrlV1Schema,
}));

export const BrowserPopupRequestedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('popupRequested'),
  popupRequestId: z.string().trim().min(1).max(256),
  url: BrowserHttpUrlV1Schema,
}));

export const BrowserExternalOpenRequestedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('externalOpenRequested'),
  url: z.string().trim().min(1).max(4096),
}));

export const BrowserViewCrashedEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('viewCrashed'),
  reasonCode: z.string().trim().min(1).max(128),
  autoReloadAttempted: z.boolean().optional().default(false),
}));

export const BrowserAdapterUnavailableEventV1Schema = lazyZodSchema(() => BrowserViewEventBaseV1Schema.extend({
  kind: z.literal('adapterUnavailable'),
  adapterKind: BrowserSemanticAdapterKindV1Schema,
  reasonCode: z.string().trim().min(1).max(128),
}));

export const BrowserEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BrowserSessionCreatedEventV1Schema,
  BrowserSessionClosedEventV1Schema,
  BrowserViewOpenedEventV1Schema,
  BrowserViewClosedEventV1Schema,
  BrowserViewFocusedEventV1Schema,
  BrowserTargetChangedEventV1Schema,
  BrowserNavigationStartedEventV1Schema,
  BrowserNavigationCommittedEventV1Schema,
  BrowserNavigationFinishedEventV1Schema,
  BrowserNavigationFailedEventV1Schema,
  BrowserNavigationStateChangedEventV1Schema,
  BrowserControllerChangedEventV1Schema,
  BrowserTitleChangedEventV1Schema,
  BrowserFaviconChangedEventV1Schema,
  BrowserLoadingProgressChangedEventV1Schema,
  BrowserPermissionRequestedEventV1Schema,
  BrowserDownloadRequestedEventV1Schema,
  BrowserPopupRequestedEventV1Schema,
  BrowserExternalOpenRequestedEventV1Schema,
  BrowserViewCrashedEventV1Schema,
  BrowserAdapterUnavailableEventV1Schema,
]));
export type BrowserEventV1 = z.infer<typeof BrowserEventV1Schema>;

/** One metadata observation includes both authorities so stream startup can retain just the latest. */
export const BrowserEventBatchV1Schema = lazyZodSchema(() => z.object({ v: z.literal(1), events: z.array(BrowserEventV1Schema) }).strict());
