import { z } from 'zod';

import {
    AttentionDeviceOverridesV1Schema,
    DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
    type AttentionDeviceOverridesV1,
} from '../../attentionDeviceOverridesV1';
import {
    PET_COMPANION_SIZE_SCALE_DEFAULT,
    normalizePetCompanionSizeScale,
} from '@/sync/domains/pets/companionSizeScale';
import {
    PET_COMPANION_POSITION_DEFAULT,
    PetCompanionStoredPositionSchema,
} from '@/sync/domains/pets/companionPosition/companionPosition';
import { serializeDesktopOverlayAutoHideDelayBucket } from './localSettingDefinitions.shared';

const PetEnabledOverrideSchema = z.enum(['inherit', 'enabled', 'disabled']);
const PetSelectedOverrideSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inherit') }),
    z.object({
        kind: z.literal('detectedCodexHome'),
        sourceKey: z.string().min(1),
    }),
    z.object({
        kind: z.literal('happierManagedLocal'),
        sourceKey: z.string().min(1),
    }),
]);
const DesktopPetOverlayVisibilityModeOverrideSchema = z.enum([
    'inherit',
    'attentionOrActive',
    'alwaysWhenEnabled',
    'attentionOnly',
]);
const DesktopPetOverlayAnchorSchema = z.enum(['bottomRight', 'bottomLeft', 'topRight', 'topLeft']);
const DesktopPetOverlayOffsetSchema = z.object({
    x: z.number(),
    y: z.number(),
});
const PetCompanionSizeScaleSchema = z.number().catch(PET_COMPANION_SIZE_SCALE_DEFAULT);

function serializePetCompanionSizeScaleBucket(value: number): 'small' | 'default' | 'large' | 'xlarge' {
    const scale = normalizePetCompanionSizeScale(value);
    if (scale < 0.95) return 'small';
    if (scale <= 1.05) return 'default';
    if (scale <= 1.25) return 'large';
    return 'xlarge';
}

export const ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS = {
    activitySurfacesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable activity surfaces on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable Live Activities on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesStrategy: {
        schema: z.enum(['dynamic_primary', 'pinned_primary', 'session_specific']),
        default: 'dynamic_primary',
        description: 'Live Activity slot strategy on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    iosLiveActivitiesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Deprecated: legacy iOS Live Activities toggle',
        storageScope: 'local',
    },
    widgetsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable widgets on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    widgetsPresetMode: {
        schema: z.enum(['summary', 'attention', 'running']),
        default: 'summary',
        description: 'Widget presentation mode on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    widgetsShowPreviewText: {
        schema: z.boolean(),
        default: true,
        description: 'Show preview text in home screen widgets',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    widgetsShowMachinePath: {
        schema: z.boolean(),
        default: true,
        description: 'Show machine and path in home screen widgets',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    iosWidgetsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Deprecated: legacy iOS widget toggle',
        storageScope: 'local',
    },
    liveActivitiesMode: {
        schema: z.enum(['focused', 'attention', 'running']),
        default: 'focused',
        description: 'Default iOS Live Activities presentation mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesMaxConcurrent: {
        schema: z.union([z.literal(1), z.literal(2), z.literal(4)]),
        default: 1,
        description: 'Maximum concurrent iOS Live Activities',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesShowPreviewText: {
        schema: z.boolean(),
        default: true,
        description: 'Show preview text in iOS Live Activities',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesAllowActionButtons: {
        schema: z.boolean(),
        default: true,
        description: 'Allow action buttons in iOS Live Activities',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesIncludeReady: {
        schema: z.boolean(),
        default: true,
        description: 'Include ready sessions in iOS Live Activities',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    liveActivitiesIncludeThinking: {
        schema: z.boolean(),
        default: true,
        description: 'Include thinking sessions in iOS Live Activities',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    homeScreenWidgetsMode: {
        schema: z.enum(['summary', 'attention', 'running']),
        default: 'summary',
        description: 'Deprecated: legacy iOS home screen widget presentation mode',
        storageScope: 'local',
    },
    homeScreenWidgetsShowPreviewText: {
        schema: z.boolean(),
        default: true,
        description: 'Deprecated: legacy iOS widget preview toggle',
        storageScope: 'local',
    },
    homeScreenWidgetsShowMachinePath: {
        schema: z.boolean(),
        default: true,
        description: 'Deprecated: legacy iOS widget machine/path toggle',
        storageScope: 'local',
    },
    activitySurfaceTapTarget: {
        schema: z.enum(['open_session', 'open_sessions']),
        default: 'open_session',
        description: 'Tap target for activity surfaces on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    activitySurfacePrivacyMode: {
        schema: z.enum(['status_only', 'title_only', 'include_preview']),
        default: 'title_only',
        description: 'Privacy level for activity surface previews on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    /*
     * The floating Voice orb is a per-device presence, deliberately kept out of the synced
     * `voice.ui.*` tree: a companion that is welcome on a phone can be unwelcome on a desktop
     * where the pet already owns that corner, and a synced flag forces one answer onto both.
     * Turning it off suppresses the presence only — Voice keeps running and stays reachable from
     * the sidebar and the composer.
     */
    voiceOrbEnabled: {
        schema: z.boolean().catch(true),
        default: true,
        description: 'Show the floating Voice orb on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    /*
     * Expanded vs minimised is a preference, not transient state: it survives the app so someone
     * who keeps Voice out of the way does not have to re-make that choice every launch.
     */
    voiceOrbExpanded: {
        schema: z.boolean().catch(false),
        default: false,
        description: 'Voice orb expanded on this device',
        storageScope: 'local',
    },
    petsEnabledOverride: {
        schema: PetEnabledOverrideSchema,
        default: 'inherit',
        description: 'Device override for pet companion enablement',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    petsSelectedPetOverride: {
        schema: PetSelectedOverrideSchema,
        default: { kind: 'inherit' },
        description: 'Device-only pet package override',
        storageScope: 'local',
    },
    petsCompanionPosition: {
        schema: PetCompanionStoredPositionSchema,
        default: PET_COMPANION_POSITION_DEFAULT,
        description: 'Versioned normalized app-shell pet companion position on this device',
        storageScope: 'local',
    },
    petsDismissedCompanionTrayItemKeys: {
        schema: z.array(z.string().min(1)).catch([]),
        default: [],
        description: 'Device-local dismissed pet companion activity bubble keys',
        storageScope: 'local',
    },
    petsCompanionSizeScale: {
        schema: PetCompanionSizeScaleSchema,
        default: PET_COMPANION_SIZE_SCALE_DEFAULT,
        description: 'Local companion size scale for pet surfaces on this device',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializePetCompanionSizeScaleBucket,
        },
    },
    petsDetectCodexPets: {
        schema: z.boolean(),
        default: true,
        description: 'Discover Codex pet packages from local Codex homes on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayEnabledOverride: {
        schema: PetEnabledOverrideSchema,
        default: 'inherit',
        description: 'Device override for desktop pet overlay enablement',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayVisibilityModeOverride: {
        schema: DesktopPetOverlayVisibilityModeOverrideSchema,
        default: 'inherit',
        description: 'Device override for desktop pet overlay visibility mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayAnchor: {
        schema: DesktopPetOverlayAnchorSchema,
        default: 'bottomRight',
        description: 'Desktop pet overlay anchor on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayOffset: {
        schema: DesktopPetOverlayOffsetSchema,
        default: { x: 0, y: 0 },
        description: 'Desktop pet overlay offset from the selected anchor on this device',
        storageScope: 'local',
    },
    desktopPetOverlayLocked: {
        schema: z.boolean(),
        default: false,
        description: 'Lock desktop pet overlay dragging on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable the local desktop overlay on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayVisibilityMode: {
        schema: z.enum(['attention_only', 'active_sessions', 'always_when_enabled']),
        default: 'attention_only',
        description: 'Desktop overlay visibility mode on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayShowWhenRunning: {
        schema: z.boolean(),
        default: true,
        description: 'Show the desktop overlay when sessions are running',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayShowWhenAttentionRequired: {
        schema: z.boolean(),
        default: true,
        description: 'Show the desktop overlay when attention is required',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayShowWhenReady: {
        schema: z.boolean(),
        default: true,
        description: 'Show the desktop overlay when a session is ready for input',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayAlwaysOnTop: {
        schema: z.boolean(),
        default: true,
        description: 'Keep the desktop overlay above other windows',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayAutoHideEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Auto-hide the desktop overlay after inactivity',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayAutoHideDelayMs: {
        schema: z.number(),
        default: 6_000,
        description: 'Auto-hide delay for the desktop overlay in milliseconds',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializeDesktopOverlayAutoHideDelayBucket,
        },
    },
    desktopOverlayExpandedBehavior: {
        schema: z.enum(['click', 'hover']),
        default: 'click',
        description: 'Legacy compatibility: historical desktop overlay expand behavior',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayInteractiveCollapsed: {
        schema: z.boolean(),
        default: true,
        description: 'Legacy compatibility: historical collapsed-overlay interaction toggle',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayPresentationMode: {
        schema: z.enum(['automatic', 'notch_integrated', 'floating_overlay']),
        default: 'automatic',
        description: 'Desktop overlay presentation mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayEnableDragReposition: {
        schema: z.boolean(),
        default: false,
        description: 'Allow dragging the desktop overlay to reposition it',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayLockPosition: {
        schema: z.boolean(),
        default: true,
        description: 'Lock the desktop overlay position',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayPlacementMode: {
        schema: z.enum(['anchored', 'custom']),
        default: 'anchored',
        description: 'Desktop overlay placement mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayAnchor: {
        schema: z.enum(['top_center', 'top_left', 'top_right', 'bottom_center', 'bottom_left', 'bottom_right', 'left_center', 'right_center']),
        default: 'top_center',
        description: 'Desktop overlay anchor preset',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayOffsetX: {
        schema: z.number(),
        default: 0,
        description: 'Desktop overlay horizontal offset',
        storageScope: 'local',
    },
    desktopOverlayOffsetY: {
        schema: z.number(),
        default: 0,
        description: 'Desktop overlay vertical offset',
        storageScope: 'local',
    },
    desktopOverlayClickAction: {
        schema: z.enum(['expand_overlay', 'open_primary_session', 'open_sessions']),
        default: 'expand_overlay',
        description: 'Legacy compatibility: historical desktop overlay click action',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayDensity: {
        schema: z.enum(['compact', 'comfortable']),
        default: 'compact',
        description: 'Legacy compatibility: historical desktop overlay density',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayShowSessionCount: {
        schema: z.boolean(),
        default: true,
        description: 'Legacy compatibility: historical desktop overlay session-count toggle',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayShowPreviewText: {
        schema: z.boolean(),
        default: false,
        description: 'Show preview text in the collapsed desktop overlay',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopOverlayCompactStyle: {
        schema: z.enum(['pill', 'panel']),
        default: 'pill',
        description: 'Legacy compatibility: historical desktop overlay compact style',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    attentionDeviceOverridesV1: {
        schema: AttentionDeviceOverridesV1Schema,
        default: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
        description: 'Canonical local device overrides for attention delivery and activity surfaces',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'device_user',
            serializeCurrentProperties: (value: AttentionDeviceOverridesV1) => ({
                enabled: value.enabled,
                localNotificationsEnabled: value.localNotifications.enabled,
                foregroundBehavior: value.foregroundBehavior,
                quietHoursMode: value.quietHoursOverride.mode,
                desktopHoverExpandDelay: value.desktopOverlay.hoverExpandDelay,
                desktopCarouselEnabled: value.desktopOverlay.collapsedCarouselEnabled,
                liveActivityRemoteModeOverride: value.liveActivities.remoteUpdateModeOverride,
                terminalSmartSuppressionEnabled: value.terminalSmartSuppression.enabled,
            }),
        },
    },
} as const;
