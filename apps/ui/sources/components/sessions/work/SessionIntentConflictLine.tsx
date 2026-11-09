import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

/**
 * The Session moved after the person reviewed it: a Session intent Action returns the typed `conflict`
 * without writing. A stale change is a change to review, not a refusal, so a surface that sees this
 * holds the change it asked for instead of reporting a failure.
 */
export function isStaleSessionIntent(result: ActionExecuteResult): boolean {
    return !result.ok && result.errorCode === 'conflict';
}

/**
 * Work's one line for a held stale change: that the section changed somewhere else, what it holds now
 * when the surface can say that in a word, and the two ways forward — send the held change again on the
 * Session's current revision, or let it go. The control above keeps showing the current value.
 */
export function SessionIntentConflictLine(props: Readonly<{
    testID: string;
    /** The section's own name ("Instructions", "Voice"). */
    subject: string;
    /** What the Session holds now ("Release captain", "On"), when it reads as a word. */
    current?: string;
    onApply: () => void;
    onKeep: () => void;
}>): React.ReactElement {
    return (
        <SurfaceFreshnessLine
            testID={props.testID}
            tone="warning"
            emphasis={props.subject}
            reason={props.current
                ? t('sessionIntentConflict.changedNow', { subject: props.subject, current: props.current })
                : t('sessionIntentConflict.changed', { subject: props.subject })}
            actions={[
                { label: t('sessionIntentConflict.apply'), emphasis: 'primary', testID: `${props.testID}.apply`, onPress: props.onApply },
                { label: t('sessionIntentConflict.keep'), testID: `${props.testID}.keep`, onPress: props.onKeep },
            ]}
        />
    );
}
