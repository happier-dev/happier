import { z } from 'zod/mini';

import { SessionCompanionPreferencesV1Schema } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { StoredNavigationSurfacePlacementsV1Schema } from '../../navigationPlacement';
import { DEFAULT_RIGHT_PREFERRED_PX, DEFAULT_SESSION_WIDTH_PX } from '@/components/ui/panels/paneBreakpoints';
import { HAPPIER_NEEDS_YOU_HIGHLIGHTS } from '@happier-dev/plugin-ui/presentation';

import {
    objectKeyCount,
    serializePaneSizePxBucket,
} from './localSettingDefinitions.shared';

const TERMINAL_ARROW_PAD_PLACEMENT_SCHEMA = z.strictObject({
    side: z.enum(['left', 'right']),
    y: z.number().check(z.minimum(0), z.maximum(1)),
    tucked: z.boolean(),
});

export const LAYOUT_LOCAL_SETTING_DEFINITIONS = {
    paneArrangement: {
        schema: z.catch(z.enum(['session', 'editor']), 'session'), default: 'session',
        description: 'Pane arrangement on this device', storageScope: 'local',
    },
    // How the docked right panel stands against the page (calm-shell R4-2, R11-3): `separate`, its own sheet
    // on the canvas beside the page like the sidebar; or joined to the page, divided by a `line` or by a soft
    // `shadow` (the default, owner 11-01). Window geometry, like the arrangement. The values before R11-3 read
    // as their successors: `canvas` is Separate, `sheet` is Line; anything else reads as the default.
    rightPanelPlacement: {
        schema: z.catch(z.pipe(z.transform((value: unknown) => value === 'canvas' ? 'separate' : value === 'sheet' ? 'line' : value),
            z.enum(['separate', 'line', 'shadow'])), 'shadow'),
        default: 'shadow',
        description: 'Right panel separation on this device', storageScope: 'local',
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
    newSessionDockedWidthPx: {
        schema: z.nullable(z.number()),
        // Unset, Docked New takes the Session composer's width in the column it sits in; its side edges
        // narrow or widen it (up to the column) on this device.
        default: null,
        description: 'Preferred Docked New session card width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: (widthPx: number | null) => widthPx === null ? 'large' : serializePaneSizePxBucket(464, 720)(widthPx),
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
} as const;
