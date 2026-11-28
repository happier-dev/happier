import { listUiActionSpecsForPlacement } from '../actionSpecs.js';
import type { ActionId } from '../actionIds.js';
import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { SESSION_ACTION_METADATA, type SessionActionMetadataId } from '../../sessions/actions/sessionActionMetadata.js';
import type { QualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';

export type DerivedKeyboardCommandId = `action:${ActionId | QualifiedPluginActionId}` | `session.action:${SessionActionMetadataId}`;

/** Bindable palette commands share their identity and presentation with their catalog owner. */
export const DERIVED_KEYBOARD_COMMAND_METADATA = lazyActionSpecArray(() => [
    ...listUiActionSpecsForPlacement('command_palette').map(spec => ({
        id: `action:${spec.id}` as const,
        titleKey: 'settingsKeyboard.groupApp' as const,
        title: spec.title,
        group: 'general' as const,
    })),
    ...Object.entries(SESSION_ACTION_METADATA).map(([id, metadata]) => ({
        id: `session.action:${id}` as `session.action:${SessionActionMetadataId}`,
        titleKey: metadata.titleKey === 'bots.talk' ? 'settingsKeyboard.commands.voiceToggle' as const : metadata.titleKey,
        group: 'sessions' as const,
    })),
]);
