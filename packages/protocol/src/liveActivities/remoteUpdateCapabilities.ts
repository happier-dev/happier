import { z } from 'zod';

import {
  LiveActivityRemoteTargetKindSchema,
  LiveActivityRemoteTransportModeSchema,
  LiveActivityRemoteUpdateEventSchema,
  type LiveActivityRemoteTargetKind,
  type LiveActivityRemoteTransportMode,
  type LiveActivityRemoteUpdateEvent,
} from './remoteUpdates.js';

const LiveActivityRemoteUpdateCapabilityReasonSchema = z.enum([
  'expo_widgets_push_notifications_disabled',
  'hosted_relay_not_allowed',
  'hosted_relay_provider_blocked',
  'hosted_relay_capability_missing',
  'direct_apns_not_configured',
  'background_wake_disabled',
  'not_in_phase_9_5',
  'private_per_session_surface_not_broadcast',
]);

const LiveActivityDirectApnsConfigurationDiagnosticSchema = z.enum([
  'apns_team_id_missing',
  'apns_key_id_missing',
  'apns_private_key_missing',
  'apns_private_key_must_be_p8_token_key',
  'apns_bundle_id_allowlist_missing',
]);

export const LiveActivityRemoteUpdateModeDiagnosticSchema = z
  .object({
    available: z.boolean(),
    reasons: z.array(LiveActivityRemoteUpdateCapabilityReasonSchema),
    configurationDiagnostics: z
      .array(LiveActivityDirectApnsConfigurationDiagnosticSchema)
      .optional()
      .default([]),
  })
  .strict();

const LiveActivityPerActivityUpdateCapabilityDiagnosticSchema = z
  .object({
    id: z.literal('per_activity_update'),
    status: z.enum(['supported_when_configured', 'future_unsupported']),
    events: z.array(LiveActivityRemoteUpdateEventSchema),
    targetKinds: z.array(LiveActivityRemoteTargetKindSchema),
    availableModes: z.array(LiveActivityRemoteTransportModeSchema),
    reasons: z.array(LiveActivityRemoteUpdateCapabilityReasonSchema),
  })
  .strict();

const LiveActivityPushToStartCapabilityDiagnosticSchema = z
  .object({
    id: z.literal('push_to_start'),
    status: z.enum(['supported_when_configured', 'future_unsupported']),
    events: z.tuple([z.literal('start')]),
    targetKinds: z.array(LiveActivityRemoteTargetKindSchema),
    availableModes: z.array(LiveActivityRemoteTransportModeSchema),
    reasons: z.array(LiveActivityRemoteUpdateCapabilityReasonSchema),
  })
  .strict();

const LiveActivityBroadcastChannelCapabilityDiagnosticSchema = z
  .object({
    id: z.literal('broadcast_channel'),
    status: z.enum(['supported_when_configured', 'future_unsupported']),
    events: z.tuple([]),
    targetKinds: z.array(LiveActivityRemoteTargetKindSchema),
    availableModes: z.array(LiveActivityRemoteTransportModeSchema),
    reasons: z.array(LiveActivityRemoteUpdateCapabilityReasonSchema),
  })
  .strict();

export const LiveActivityRemoteUpdateCapabilityDiagnosticsSchema = z
  .object({
    modes: z
      .object({
        hosted_happier_relay: LiveActivityRemoteUpdateModeDiagnosticSchema,
        direct_apns: LiveActivityRemoteUpdateModeDiagnosticSchema,
        background_wake_best_effort: LiveActivityRemoteUpdateModeDiagnosticSchema,
      })
      .strict(),
    capabilities: z
      .object({
        perActivityUpdate: LiveActivityPerActivityUpdateCapabilityDiagnosticSchema,
        pushToStart: LiveActivityPushToStartCapabilityDiagnosticSchema,
        broadcastChannel: LiveActivityBroadcastChannelCapabilityDiagnosticSchema,
      })
      .strict(),
  })
  .strict();

export const DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS =
  buildLiveActivityRemoteUpdateCapabilityDiagnostics({
    expoWidgetsPushNotificationsEnabled: false,
    hostedRelay: {
      allowed: false,
      capabilityAvailable: false,
    },
    directApns: {
      configured: false,
    },
    backgroundWake: {
      enabled: false,
    },
  });

export type {
  LiveActivityRemoteTargetKind,
  LiveActivityRemoteTransportMode,
  LiveActivityRemoteUpdateEvent,
};

export type LiveActivityRemoteUpdateCapabilityId =
  | 'per_activity_update'
  | 'push_to_start'
  | 'broadcast_channel';

export type LiveActivityRemoteUpdateCapabilityStatus =
  | 'supported_when_configured'
  | 'future_unsupported';

export type LiveActivityRemoteUpdateMode =
  | LiveActivityRemoteTransportMode
  | 'local_only'
  | 'disabled';

export type LiveActivityRemoteUpdateModeResolutionReason =
  | 'selected'
  | 'fallback'
  | 'preferred_unavailable'
  | 'local_only'
  | 'disabled';

export type LiveActivityRemoteUpdateCapabilityReason =
  | 'expo_widgets_push_notifications_disabled'
  | 'hosted_relay_not_allowed'
  | 'hosted_relay_provider_blocked'
  | 'hosted_relay_capability_missing'
  | 'direct_apns_not_configured'
  | 'background_wake_disabled'
  | 'not_in_phase_9_5'
  | 'private_per_session_surface_not_broadcast';

export type LiveActivityDirectApnsConfigurationDiagnostic =
  | 'apns_team_id_missing'
  | 'apns_key_id_missing'
  | 'apns_private_key_missing'
  | 'apns_private_key_must_be_p8_token_key'
  | 'apns_bundle_id_allowlist_missing';

export type LiveActivityRemoteUpdateModeDiagnostic = Readonly<{
  available: boolean;
  reasons: LiveActivityRemoteUpdateCapabilityReason[];
  configurationDiagnostics: LiveActivityDirectApnsConfigurationDiagnostic[];
}>;

export type LiveActivityPerActivityUpdateCapabilityDiagnostic = Readonly<{
  id: 'per_activity_update';
  status: LiveActivityRemoteUpdateCapabilityStatus;
  events: LiveActivityRemoteUpdateEvent[];
  targetKinds: LiveActivityRemoteTargetKind[];
  availableModes: LiveActivityRemoteTransportMode[];
  reasons: LiveActivityRemoteUpdateCapabilityReason[];
}>;

export type LiveActivityPushToStartCapabilityDiagnostic = Readonly<{
  id: 'push_to_start';
  status: LiveActivityRemoteUpdateCapabilityStatus;
  events: ['start'];
  targetKinds: LiveActivityRemoteTargetKind[];
  availableModes: LiveActivityRemoteTransportMode[];
  reasons: LiveActivityRemoteUpdateCapabilityReason[];
}>;

export type LiveActivityBroadcastChannelCapabilityDiagnostic = Readonly<{
  id: 'broadcast_channel';
  status: LiveActivityRemoteUpdateCapabilityStatus;
  events: [];
  targetKinds: LiveActivityRemoteTargetKind[];
  availableModes: LiveActivityRemoteTransportMode[];
  reasons: LiveActivityRemoteUpdateCapabilityReason[];
}>;

export type LiveActivityRemoteUpdateCapabilityDiagnostic =
  | LiveActivityPerActivityUpdateCapabilityDiagnostic
  | LiveActivityPushToStartCapabilityDiagnostic
  | LiveActivityBroadcastChannelCapabilityDiagnostic;

type LiveActivityRemoteUpdateCapabilitiesDiagnostics = Readonly<{
  perActivityUpdate: LiveActivityPerActivityUpdateCapabilityDiagnostic;
  pushToStart: LiveActivityPushToStartCapabilityDiagnostic;
  broadcastChannel: LiveActivityBroadcastChannelCapabilityDiagnostic;
}>;

export type BuildLiveActivityRemoteUpdateCapabilityDiagnosticsInput = Readonly<{
  expoWidgetsPushNotificationsEnabled: boolean;
  hostedRelay: Readonly<{
    allowed: boolean;
    capabilityAvailable: boolean;
    providerImplemented?: boolean;
  }>;
  directApns: Readonly<{
    configured: boolean;
    configurationDiagnostics?: readonly LiveActivityDirectApnsConfigurationDiagnostic[];
  }>;
  backgroundWake: Readonly<{
    enabled: boolean;
  }>;
}>;

export type LiveActivityRemoteUpdateCapabilityDiagnostics = Readonly<{
  modes: Readonly<Record<LiveActivityRemoteTransportMode, LiveActivityRemoteUpdateModeDiagnostic>>;
  capabilities: LiveActivityRemoteUpdateCapabilitiesDiagnostics;
}>;

export type ResolveLiveActivityRemoteUpdateModeParams = Readonly<{
  preferredMode: LiveActivityRemoteUpdateMode;
  diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics;
  allowFallback: boolean;
}>;

export type LiveActivityRemoteUpdateModeResolution = Readonly<{
  mode: LiveActivityRemoteUpdateMode;
  reason: LiveActivityRemoteUpdateModeResolutionReason;
}>;

const LIVE_ACTIVITY_REMOTE_TRANSPORT_MODE_FALLBACK_ORDER = [
  'hosted_happier_relay',
  'direct_apns',
  'background_wake_best_effort',
] satisfies LiveActivityRemoteTransportMode[];

function buildModeDiagnostic(
  reasons: LiveActivityRemoteUpdateCapabilityReason[],
  configurationDiagnostics: readonly LiveActivityDirectApnsConfigurationDiagnostic[] = [],
): LiveActivityRemoteUpdateModeDiagnostic {
  return {
    available: reasons.length === 0,
    reasons,
    configurationDiagnostics: [...configurationDiagnostics],
  };
}

function resolveHostedRelayReasons(
  input: BuildLiveActivityRemoteUpdateCapabilityDiagnosticsInput,
): LiveActivityRemoteUpdateCapabilityReason[] {
  const reasons: LiveActivityRemoteUpdateCapabilityReason[] = [];

  if (!input.expoWidgetsPushNotificationsEnabled) {
    reasons.push('expo_widgets_push_notifications_disabled');
  }
  if (!input.hostedRelay.allowed) {
    reasons.push('hosted_relay_not_allowed');
  }
  if (input.hostedRelay.providerImplemented === false) {
    reasons.push('hosted_relay_provider_blocked');
  }
  if (!input.hostedRelay.capabilityAvailable) {
    reasons.push('hosted_relay_capability_missing');
  }

  return reasons;
}

function resolveDirectApnsReasons(
  input: BuildLiveActivityRemoteUpdateCapabilityDiagnosticsInput,
): LiveActivityRemoteUpdateCapabilityReason[] {
  const reasons: LiveActivityRemoteUpdateCapabilityReason[] = [];

  if (!input.expoWidgetsPushNotificationsEnabled) {
    reasons.push('expo_widgets_push_notifications_disabled');
  }
  if (!input.directApns.configured) {
    reasons.push('direct_apns_not_configured');
  }

  return reasons;
}

function resolveBackgroundWakeReasons(
  input: BuildLiveActivityRemoteUpdateCapabilityDiagnosticsInput,
): LiveActivityRemoteUpdateCapabilityReason[] {
  return input.backgroundWake.enabled ? [] : ['background_wake_disabled'];
}

function resolveAvailableModes(
  modes: Readonly<Record<LiveActivityRemoteTransportMode, LiveActivityRemoteUpdateModeDiagnostic>>,
): LiveActivityRemoteTransportMode[] {
  return ([
    'hosted_happier_relay',
    'direct_apns',
    'background_wake_best_effort',
  ] satisfies LiveActivityRemoteTransportMode[]).filter((mode) => modes[mode].available);
}

function isLiveActivityRemoteTransportMode(
  mode: LiveActivityRemoteUpdateMode,
): mode is LiveActivityRemoteTransportMode {
  return LIVE_ACTIVITY_REMOTE_TRANSPORT_MODE_FALLBACK_ORDER.includes(
    mode as LiveActivityRemoteTransportMode,
  );
}

export function buildLiveActivityRemoteUpdateCapabilityDiagnostics(
  input: BuildLiveActivityRemoteUpdateCapabilityDiagnosticsInput,
): LiveActivityRemoteUpdateCapabilityDiagnostics {
  const modes = {
    hosted_happier_relay: buildModeDiagnostic(resolveHostedRelayReasons(input)),
    direct_apns: buildModeDiagnostic(
      resolveDirectApnsReasons(input),
      input.directApns.configurationDiagnostics,
    ),
    background_wake_best_effort: buildModeDiagnostic(resolveBackgroundWakeReasons(input)),
  } satisfies Record<LiveActivityRemoteTransportMode, LiveActivityRemoteUpdateModeDiagnostic>;

  return {
    modes,
    capabilities: {
      perActivityUpdate: {
        id: 'per_activity_update',
        status: 'supported_when_configured',
        events: ['update', 'end'],
        targetKinds: ['activitykit_update_token'],
        availableModes: resolveAvailableModes(modes),
        reasons: [],
      },
      pushToStart: {
        id: 'push_to_start',
        status: 'future_unsupported',
        events: ['start'],
        targetKinds: ['activitykit_push_to_start_token'],
        availableModes: [],
        reasons: ['not_in_phase_9_5'],
      },
      broadcastChannel: {
        id: 'broadcast_channel',
        status: 'future_unsupported',
        events: [],
        targetKinds: [],
        availableModes: [],
        reasons: ['private_per_session_surface_not_broadcast'],
      },
    },
  };
}

export function resolveLiveActivityRemoteUpdateMode(
  params: ResolveLiveActivityRemoteUpdateModeParams,
): LiveActivityRemoteUpdateModeResolution {
  if (params.preferredMode === 'disabled') {
    return { mode: 'disabled', reason: 'disabled' };
  }

  if (params.preferredMode === 'local_only') {
    return { mode: 'local_only', reason: 'local_only' };
  }

  if (
    isLiveActivityRemoteTransportMode(params.preferredMode)
    && params.diagnostics.modes[params.preferredMode].available
  ) {
    return { mode: params.preferredMode, reason: 'selected' };
  }

  if (params.allowFallback) {
    const fallbackMode = LIVE_ACTIVITY_REMOTE_TRANSPORT_MODE_FALLBACK_ORDER.find(
      (mode) => params.diagnostics.modes[mode].available,
    );
    if (fallbackMode) {
      return { mode: fallbackMode, reason: 'fallback' };
    }
  }

  return { mode: 'local_only', reason: 'preferred_unavailable' };
}
