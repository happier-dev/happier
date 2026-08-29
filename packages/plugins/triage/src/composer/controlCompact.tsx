import * as React from 'react';
import type { PluginUiIconTokenV1, RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    Icon,
    Row,
    Text,
    defineUiSurface,
    useComposerView,
    usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { PluginTranslate } from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../displayName.js';
import { TRIAGE_ENTRIES_CONTROL_ICON_V1 } from '../ui/contributions.js';
import {
    projectTriageEntriesCompactState,
    type TriageEntriesCompactStateV1,
} from './attachedEntries.js';
import { readTriageComposerControlMount } from './composerMount.js';
import { useTriageBoundComposer } from './useBoundComposer.js';

/**
 * The compact label of the `entries` composer control (`core/COMPOSER.md` §1.2).
 *
 * Zero, one and many are derived from the canonical composer snapshot on every
 * read, under the approved attachment-derived compact state. This renderer owns
 * no chip list, no attachment count, no selected set and no memory of a
 * previous frame: a second store outlives a host badge removal, an undo and a
 * closed scope, and then keeps claiming attachments the message will not carry.
 *
 * The host stamps its own `state.count`/`state.label` on this mount. They are
 * deliberately not read — the mount binding does not even carry them — because
 * two counts for one draft is exactly the split the amendment exists to remove.
 *
 * Presentation only. Pressing the control, opening the picker, the overflow
 * fallback and the control chrome all remain the host's.
 */

/**
 * The one label this control shows, in the reader's own language.
 *
 * Only the many-arm is a SENTENCE, so only it is resolved through the host
 * catalog. The other two carry no words of ours: `staticTitle` is the plugin's
 * own display name, and `entry` is the host-presented label of the attached
 * record. A count assembled here as `${n} ${name}` shipped English word order
 * to every locale — and it is the arm a reader sees most often, because a draft
 * with several entries is the ordinary case this control exists for.
 */
function compactLabel(state: TriageEntriesCompactStateV1, text: PluginTranslate): string {
    switch (state.label.kind) {
        case 'staticTitle':
            return TRIAGE_DISPLAY_NAME;
        case 'entry':
            return state.label.text;
        case 'count':
            return text(
                'plugins.triage.composer.entriesCount',
                `${state.label.count} ${TRIAGE_DISPLAY_NAME}`,
                { count: state.label.count },
            );
    }
}

function compactIcon(state: TriageEntriesCompactStateV1): PluginUiIconTokenV1 {
    return state.icon.kind === 'admitted' ? state.icon.token : TRIAGE_ENTRIES_CONTROL_ICON_V1;
}

export function TriageEntriesControlCompact(context: RenderContext): React.ReactElement {
    const text = usePluginTranslation();
    const mount = readTriageComposerControlMount(context.launchInput);
    const handle = useTriageBoundComposer(mount.status === 'bound' ? mount.composer : null);
    const composerView = useComposerView(handle);
    const state = projectTriageEntriesCompactState(composerView.result);
    const label = compactLabel(state, text);

    return (
        <Row gap="small" align="center">
            <Icon
                name={compactIcon(state)}
                size="small"
                tone={state.selected ? 'accent' : 'neutral'}
            />
            {/*
              * One line, and the label is the accessible name: a truncated
              * visual label with no accessible full text is the usual way a
              * long entry title becomes unreadable to a screen reader.
              */}
            <Text
                value={label}
                variant="label"
                numberOfLines={1}
                accessibilityLabel={label}
            />
        </Row>
    );
}

export const renderSurface: RenderSurface = defineUiSurface(TriageEntriesControlCompact);
