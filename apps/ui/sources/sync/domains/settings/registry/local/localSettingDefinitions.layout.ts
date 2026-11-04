import { HAPPIER_NEEDS_YOU_HIGHLIGHTS } from '@happier-dev/plugin-ui/presentation';
import { z } from 'zod/mini';

import { SessionCompanionPreferencesV1Schema } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { normalizeSessionMobileSurface, type SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { normalizeProjectMobileSurface, type ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { StoredNavigationSurfacePlacementsV1Schema } from '../../mobileSurfacePinning';
import { DEFAULT_RIGHT_PREFERRED_PX, DEFAULT_SESSION_WIDTH_PX } from '@/components/ui/panels/paneBreakpoints';

import {
    EMPTY_PERSISTED_PANE_SCOPE_STATE,
    objectKeyCount,
    paneScopeStateSchema,
    serializePaneSizePxBucket,
} from './localSettingDefinitions.shared';

const sessionMobileSurfaceSchema = z.custom<SessionMobileSurface>((value) => (
    typeof value === 'string' && normalizeSessionMobileSurface(value) === value
));
const projectMobileSurfaceSchema = z.custom<ProjectMobileSurface>((value) => (
    typeof value === 'string' && normalizeProjectMobileSurface(value) === value
));

const TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA = z.strictObject({
    side: z.enum(['left', 'right']),
    y: z.number().check(z.minimum(0), z.maximum(1)),
    tucked: z.boolean(),
});

const compactAppDestinationIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));
const compactAppDestinationPreferencesSchema = z.strictObject({
    orderedDestinationIds: z._default(z.array(compactAppDestinationIdSchema).check(z.maxLength(128)), []),
    hiddenDestinationIds: z._default(z.array(compactAppDestinationIdSchema).check(z.maxLength(128)), []),
});

export const LAYOUT_LOCAL_SETTING_DEFINITIONS = {
    paneArrangement: {
        schema: z.catch(z.enum(['session', 'editor']), 'session'), default: 'session',
        description: 'Pane arrangement on this device', storageScope: 'local',
    },
    // Where the docked right panel and its rail stand: on the canvas beside the page, mirroring the
    // sidebar (calm-shell R4-2), or inside the page sheet. Window geometry, like the arrangement.
    rightPanelPlacement: {
        schema: z.catch(z.enum(['canvas', 'sheet']), 'canvas'), default: 'canvas',
        description: 'Right panel position on this device', storageScope: 'local',
    },
    // How a session that needs you stands out in the list (owner ruling 2026-11-01): Dot (the amber dot alone),
    // Accent, Glint, Shimmer or Pulse. A device preference, like the pane geometry around it.
    sessionListNeedsYouHighlight: {
        schema: z.catch(z.enum(HAPPIER_NEEDS_YOU_HIGHLIGHTS), 'dot'), default: 'dot',
        description: 'How sessions that need you stand out in the session list on this device', storageScope: 'local',
    },
    sessionColumnWidthPx: {
        schema: z.number(), default: DEFAULT_SESSION_WIDTH_PX,
        description: 'Preferred session column width in px', storageScope: 'local',
    },
    collectionRailWidthsV1: {
        schema: z.catch(z.record(z.string(), z.number()), {}), default: {},
        description: 'Preferred collection rail widths by navigator on this device', storageScope: 'local',
    },
    uiSurfaceFinish: {
        schema: z.catch(z.enum(['flat', 'soft']), 'soft'), default: 'soft',
        description: 'Surface finish on this device', storageScope: 'local',
    },
    uiSurfaceFinishOverrides: {
        schema: z.catch(z.object({
            card: z.catch(z.optional(z.enum(['flat', 'soft'])), undefined),
            floating: z.catch(z.optional(z.enum(['flat', 'soft'])), undefined),
            composer: z.catch(z.optional(z.enum(['flat', 'soft'])), undefined),
            primaryButton: z.catch(z.optional(z.enum(['flat', 'soft'])), undefined),
            secondaryButton: z.catch(z.optional(z.enum(['flat', 'soft'])), undefined),
        }), {}), default: {},
        description: 'Per-role surface finish overrides on this device; absent roles inherit', storageScope: 'local',
    },
    widgetFrameStyleHome: {
        schema: z.catch(z.enum(['card', 'plain']), 'card'), default: 'card',
        description: 'Default Home widget frame style on this device', storageScope: 'local',
    },
    widgetFrameStyleBoard: {
        schema: z.catch(z.enum(['card', 'plain']), 'card'), default: 'card',
        description: 'Default Board widget frame style on this device', storageScope: 'local',
    },
    widgetFrameStyleCompanion: {
        schema: z.catch(z.enum(['card', 'plain']), 'plain'), default: 'plain',
        description: 'Default Companion widget frame style on this device', storageScope: 'local',
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
        default: DEFAULT_RIGHT_PREFERRED_PX,
        description: 'Preferred right pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializePaneSizePxBucket(300, 480),
        },
    },
    detailsPaneWidthPx: {
        schema: z.number(),
        // The editor column a person gets before they drag it (files lab FB1: a 600 px Details drawer at 1440).
        default: 600,
        description: 'Preferred details pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializePaneSizePxBucket(300, 480),
        },
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
            serializeCurrent: serializePaneSizePxBucket(225, 360),
        },
    },
    terminalRendererPreference: {
        schema: z.catch((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === 'native-experimental' ? 'native' : value), z.enum(['auto', 'xterm-webview', 'native'])), 'auto'),
        default: 'auto',
        description: 'Preferred terminal renderer on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    terminalArrowPadPlacement: {
        // The phone terminal's floating arrow pad (terminal lab P1): side, height fraction and
        // whether it is tucked into a dot, remembered per orientation on this device only.
        schema: z.catch(z.strictObject({
            portrait: z.nullable(TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA),
            landscape: z.nullable(TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA),
        }), { portrait: null, landscape: null }),
        default: { portrait: null, landscape: null },
        description: 'Where the phone terminal arrow pad rests, per orientation',
        storageScope: 'local',
    },
    terminalNativeRendererQuarantine: {
        schema: z.catch(z.nullable(z.strictObject({
            renderer: z.enum(['ios-ghosttykit', 'android-termux']),
            expiresAtMs: z.number().check(z.positive()),
        })), null),
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
        schema: z._default(z.record(z.string(), sessionMobileSurfaceSchema), {}),
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
        schema: z.catch(StoredNavigationSurfacePlacementsV1Schema, {}),
        default: {},
        description: 'Device-local ordering and pinned, overflow or hidden placement for navigation surfaces',
        storageScope: 'local',
    },
    sessionCockpitBarSurfaceIds: {
        // The person's Session bar in order; null until they change it (host defaults apply).
        // No count cap: the bar's width decides what fits, the rest scrolls or waits in More.
        schema: z.catch(z.nullable(z.array(z.string().check(z.trim(), z.minLength(1)))), null),
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
        schema: z._default(z.record(z.string(), projectMobileSurfaceSchema), {}),
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
        schema: z._default(z.record(z.string(), z.string()), {}),
        default: {},
        description: 'Last active project root path by Home-qualified workspace ref key',
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
        schema: z._default(z.record(z.string(), z.string()), {}),
        default: {},
        description: 'Last active project worktree id by Home-qualified workspace ref key',
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
        schema: z._default(z.record(z.string(), z.catch(paneScopeStateSchema, EMPTY_PERSISTED_PANE_SCOPE_STATE)), {}),
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
        schema: z._default(z.record(z.string(), z.unknown()), {}),
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
        schema: z._default(z.record(z.string(), z.boolean()), {}),
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
    },} as const;
