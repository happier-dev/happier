import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { BrowserAdapterCapabilitiesV1Schema } from '../adapters/v1.js';
import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';
import { BrowserPlatformV1Schema } from '../view/v1.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserAutomationControllerStateV1Schema } from '../automation/v1.js';
import { BrowserEditableTargetV1Schema, BrowserViewportV1Schema } from '../input/v1.js';

const BrowserEventBaseV1Schema = lazyZodSchema(() => z.strictObject({
    eventId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    browserSessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    occurredAt: z.number().check(z.int(), z.nonnegative()),
  }));

const BrowserViewEventBaseV1Schema = lazyZodSchema(() => z.extend(BrowserEventBaseV1Schema, {
  viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  navigationGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
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

export const BrowserSessionCreatedEventV1Schema = lazyZodSchema(() => z.extend(BrowserEventBaseV1Schema, {
  kind: z.literal('sessionCreated'),
  profileId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

export const BrowserSessionClosedEventV1Schema = lazyZodSchema(() => z.extend(BrowserEventBaseV1Schema, {
  kind: z.literal('sessionClosed'),
  reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
}));

export const BrowserViewOpenedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('viewOpened'),
  target: BrowserViewTargetV1Schema,
  platform: BrowserPlatformV1Schema,
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
  currentUrlExpiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  adapterKind: BrowserSemanticAdapterKindV1Schema,
  engineKind: z.enum(BrowserRenderEngineKindV1Schema.options.filter((value): value is Exclude<(typeof BrowserRenderEngineKindV1Schema.options)[number], 'unavailable'> => !(['unavailable'] as readonly string[]).includes(value))),
  adapterCapabilities: BrowserAdapterCapabilitiesV1Schema,
  openerViewId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));

export const BrowserViewClosedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('viewClosed'),
  reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
}));

export const BrowserViewFocusedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('viewFocused'),
}));

export const BrowserTargetChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('targetChanged'),
  target: BrowserViewTargetV1Schema,
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
}));

export const BrowserNavigationStartedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('navigationStarted'),
  pendingUrl: BrowserHttpUrlV1Schema,
}));

export const BrowserNavigationCommittedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('navigationCommitted'),
  currentUrl: BrowserHttpUrlV1Schema,
  securityOrigin: z.optional(BrowserHttpOriginV1Schema),
}));

export const BrowserNavigationFinishedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('navigationFinished'),
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
}));

export const BrowserNavigationFailedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('navigationFailed'),
  failedUrl: z.optional(BrowserHttpUrlV1Schema),
  errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
}));

export const BrowserNavigationStateChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('navigationStateChanged'),
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
  pendingUrl: z.optional(BrowserHttpUrlV1Schema),
  title: z.optional(z.string().check(z.trim(), z.maxLength(512))),
  faviconUrl: z.optional(BrowserHttpUrlV1Schema),
  loadingState: BrowserNavigationLoadingStateV1Schema,
  loadingProgress: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  securityOrigin: z.optional(BrowserHttpOriginV1Schema),
  lastError: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
}));

export const BrowserTitleChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('titleChanged'),
  title: z.string().check(z.trim(), z.maxLength(512)),
}));

export const BrowserControllerChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('controllerChanged'),
  state: BrowserAutomationControllerStateV1Schema,
}));

export const BrowserFaviconChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('faviconChanged'),
  faviconUrl: z.optional(BrowserHttpUrlV1Schema),
}));

export const BrowserLoadingProgressChangedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('loadingProgressChanged'),
  loadingProgress: z.number().check(z.minimum(0), z.maximum(1)),
}));

export const BrowserPermissionRequestedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('permissionRequested'),
  permissionRequestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  permissionKind: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  origin: z.optional(BrowserHttpOriginV1Schema),
}));

export const BrowserDownloadRequestedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('downloadRequested'),
  downloadRequestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  url: BrowserHttpUrlV1Schema,
}));

export const BrowserPopupRequestedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('popupRequested'),
  popupRequestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  url: BrowserHttpUrlV1Schema,
}));

export const BrowserExternalOpenRequestedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('externalOpenRequested'),
  url: z.string().check(z.trim(), z.minLength(1), z.maxLength(4096)),
}));

export const BrowserViewCrashedEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('viewCrashed'),
  reasonCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  autoReloadAttempted: z._default(z.optional(z.boolean()), false),
}));

export const BrowserAdapterUnavailableEventV1Schema = lazyZodSchema(() => z.extend(BrowserViewEventBaseV1Schema, {
  kind: z.literal('adapterUnavailable'),
  adapterKind: BrowserSemanticAdapterKindV1Schema,
  reasonCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
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
export const BrowserEventBatchV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), events: z.array(BrowserEventV1Schema),
  viewport: z.optional(BrowserViewportV1Schema),
  /** Per-stream projection of the browser owner's controller, never viewer-decided. */
  viewerInput: z.optional(z.strictObject({ controlling: z.boolean(), controlEpoch: z.number().check(z.int(), z.nonnegative()) })),
  /** Reply only to the human viewer that requested the probe; no field content. */
  editableTarget: z.optional(BrowserEditableTargetV1Schema),
}));
export type BrowserEventBatchV1 = z.infer<typeof BrowserEventBatchV1Schema>;
