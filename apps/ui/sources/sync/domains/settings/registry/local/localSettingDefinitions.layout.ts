import { z } from 'zod';

import { SessionCompanionPreferencesV1Schema } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { normalizeSessionMobileSurface, type SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { StoredNavigationSurfacePlacementsV1Schema } from '../../mobileSurfacePinning';

import {
    EMPTY_PERSISTED_PANE_SCOPE_STATE,
    objectKeyCount,
    paneScopeStateSchema,
    serializeNormalizedPaneSizeWithBasisKey,
} from './localSettingDefinitions.shared';

const sessionMobileSurfaceSchema = z.custom<SessionMobileSurface>((value) => (
    typeof value === 'string' && normalizeSessionMobileSurface(value) === value
));

const TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA = z.object({
    side: z.enum(['left', 'right']),
    y: z.number().finite().min(0).max(1),
    tucked: z.boolean(),
}).strict();

const compactAppDestinationIdSchema = z.string().trim().min(1).max(256);
const compactAppDestinationPreferencesSchema = z.object({
    orderedDestinationIds: z.array(compactAppDestinationIdSchema).max(128).default([]),
    hiddenDestinationIds: z.array(compactAppDestinationIdSchema).max(128).default([]),
}).strict();

export const LAYOUT_LOCAL_SETTING_DEFINITIONS = {
    widgetFrameStyleHome: {
        schema: z.enum(['card', 'plain']).catch('card'), default: 'card',
        description: 'Default Home widget frame style on this device', storageScope: 'local',
    },
    widgetFrameStyleBoard: {
        schema: z.enum(['card', 'plain']).catch('card'), default: 'card',
        description: 'Default Board widget frame style on this device', storageScope: 'local',
    },
    widgetFrameStyleCompanion: {
        schema: z.enum(['card', 'plain']).catch('plain'), default: 'plain',
        description: 'Default Companion widget frame style on this device', storageScope: 'local',
    },
    widgetGalleryViewV1: {
        schema: z.enum(['grid', 'list']).catch('grid'), default: 'grid',
        description: 'Widget gallery view on this device', storageScope: 'local',
    },
    uiContentWidthMode: {
        schema: z.enum(['compact', 'medium', 'full']),
        default: 'compact',
        description: 'Preferred max width for main content containers',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    rightPaneWidthPx: {
        schema: z.number(),
        default: 360,
        description: 'Preferred right pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('rightPaneWidthBasisPx', 1200, 0.25, 0.4),
        },
    },
    rightPaneWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for right pane width scaling',
        storageScope: 'local',
    },
    detailsPaneWidthPx: {
        schema: z.number(),
        default: 520,
        description: 'Preferred details pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('detailsPaneWidthBasisPx', 1200, 0.25, 0.4),
        },
    },
    detailsPaneWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for details pane width scaling',
        storageScope: 'local',
    },
    bottomPaneHeightPx: {
        schema: z.number(),
        default: 320,
        description: 'Preferred bottom pane dock height in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('bottomPaneHeightBasisPx', 900, 0.25, 0.4),
        },
    },
    bottomPaneHeightBasisPx: {
        schema: z.number(),
        default: 900,
        description: 'Container height basis for bottom pane height scaling',
        storageScope: 'local',
    },
    terminalRendererPreference: {
        schema: z.preprocess(
            (value) => value === 'native-experimental' ? 'native' : value,
            z.enum(['auto', 'xterm-webview', 'native']),
        ).catch('auto'),
        default: 'auto',
        description: 'Preferred terminal renderer on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    terminalArrowPadPlacement: {
        // The phone terminal's floating arrow pad (terminal lab P1): side, height fraction and
        // whether it is tucked into a dot, remembered per orientation on this device only.
        schema: z.object({
            portrait: TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA.nullable(),
            landscape: TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA.nullable(),
        }).strict().catch({ portrait: null, landscape: null }),
        default: { portrait: null, landscape: null },
        description: 'Where the phone terminal arrow pad rests, per orientation',
        storageScope: 'local',
    },
    terminalNativeRendererQuarantine: {
        schema: z.object({
            renderer: z.enum(['ios-ghosttykit', 'android-termux']),
            expiresAtMs: z.number().finite().positive(),
        }).strict().nullable().catch(null),
        default: null,
        description: 'Temporary native terminal renderer quarantine after an attributed fatal failure',
        storageScope: 'local',
    },
    sessionsListStorageFilter: {
        schema: z.enum(['all', 'persisted', 'direct']),
        default: 'all',
        description: 'Selected session list storage filter',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    sessionLastMobileSurfaceBySessionId: {
        schema: z.record(z.string(), sessionMobileSurfaceSchema).default({}),
        default: {},
        description: 'Last active mobile session surface by realm-qualified session key',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    sessionCompanionPreferencesBySessionV1: {
        schema: SessionCompanionPreferencesV1Schema,
        default: {},
        description: 'Viewer-local Session Companion presentation preference by realm-qualified session key',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            // Session ids, item ids, titles and content never leave the device;
            // only how many Sessions this viewer has customized.
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    navigationSurfacePlacementsV1: {
        schema: StoredNavigationSurfacePlacementsV1Schema.catch({}),
        default: {},
        description: 'Device-local ordering and pinned, overflow or hidden placement for navigation surfaces',
        storageScope: 'local',
    },
    sessionCockpitBarSurfaceIds: {
        // The person's Session bar in order; null until they change it (host defaults apply).
        // No count cap: the bar's width decides what fits, the rest scrolls or waits in More.
        schema: z.array(z.string().trim().min(1)).nullable().catch(null),
        default: null,
        description: 'Tools the person keeps on the Session mobile cockpit bar, in order',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: (value: readonly string[] | null) => value?.length ?? 0,
        },
    },
    compactAppDestinationPreferencesV1: {
        schema: compactAppDestinationPreferencesSchema,
        default: { orderedDestinationIds: [], hiddenDestinationIds: [] },
        description: 'User ordering and visibility preferences for compact App destinations',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: (value: Readonly<{
                orderedDestinationIds: readonly string[];
                hiddenDestinationIds: readonly string[];
            }>) => value.orderedDestinationIds.length + value.hiddenDestinationIds.length,
        },
    },
    projectLastMobileSurfaceByWorkspaceRefId: {
        schema: z.record(z.string(), z.enum(['overview', 'browse', 'git', 'tabs', 'terminal', 'browser', 'services'])).default({}),
        default: {},
        description: 'Last active mobile project surface by realm-qualified workspace key',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    projectLastActiveRootPathByWorkspaceRefId: {
        schema: z.record(z.string(), z.string()).default({}),
        default: {},
        description: 'Last active project root path by workspace ref id',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    projectLastActiveWorktreeIdByWorkspaceRefId: {
        schema: z.record(z.string(), z.string()).default({}),
        default: {},
        description: 'Last active project worktree id by workspace ref id',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    appPaneScopesV1: {
        schema: z.record(z.string(), paneScopeStateSchema.catch(EMPTY_PERSISTED_PANE_SCOPE_STATE)).default({}),
        default: {},
        description: 'Persisted app pane scope state by scope id',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    workspaceLayoutV1: {
        schema: z.record(z.string(), z.unknown()).default({}),
        default: {},
        description: 'Current workspace layout by Account and window on this device',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    sessionComposerCollapsedBannerKinds: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Composer banner kinds collapsed on this device, honored only while sessionComposerRememberBannerVisibility is enabled',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
    acknowledgedCliVersions: {
        schema: z.record(z.string(), z.string()),
        default: {},
        description: 'Acknowledged CLI versions per machine',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
} as const;
