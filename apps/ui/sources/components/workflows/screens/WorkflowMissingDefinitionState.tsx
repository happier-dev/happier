import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * A saved workflow this route cannot open.
 *
 * It borrowed the empty-library heading and a delete confirmation's
 * consequence, so someone following a stale link was told "No saved workflows
 * yet" and that "existing Automations and runs keep working" — copy that
 * describes an empty collection and implies a deletion nothing here observed.
 * This state knows only that the requested definition could not be opened, so
 * that is what it says, and it offers the way back the route never had.
 */
export function WorkflowMissingDefinitionState(props: Readonly<{
    testID?: string;
    /** A lost in-memory copy is not evidence that its original definition is missing. */
    source?: 'definition' | 'unsaved-copy';
    /** Present wherever the route can return to the collection. */
    onOpenCollection?: () => void;
}>): React.ReactElement {
    const testID = props.testID ?? 'workflow-missing-definition';
    const draft = props.source === 'unsaved-copy';
    // The shared state composition owns layout, glyph and the live region; this keeps only its domain copy and way back.
    return (
        <SurfaceStateCard
            testID={testID}
            kind="unavailable"
            title={t(draft ? 'workflows.empty.missingDraftTitle' : 'workflows.empty.missingTitle')}
            reason={t(draft ? 'workflows.empty.missingDraftBody' : 'workflows.empty.missingBody')}
            {...(props.onOpenCollection === undefined ? {} : {
                action: { label: t('workflows.openCollection'), onPress: props.onOpenCollection, testID: `${testID}-open-collection` },
            })}
            accessibilitySemantics="alert"
        />
    );
}
