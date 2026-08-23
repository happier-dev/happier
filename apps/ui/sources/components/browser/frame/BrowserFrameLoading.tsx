import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * First paint.
 *
 * This used to be the word "Loading…" in secondary grey, centred in an otherwise empty frame — the
 * least considered moment in a surface whose whole job is to show a page. It is now the canonical
 * {@link SurfaceStateCard} in its `loading` kind: the shared spinner, the card, and — when the
 * caller knows it — the HOST being loaded, so the wait names its destination instead of naming
 * itself. The card owns the live region, so the loading → error transition is announced; the old
 * `role="status"` behaviour is preserved through `accessibilitySemantics`.
 */
export function BrowserFrameLoading(props: Readonly<{
    testID: string;
    /** The host being loaded, when the caller knows it. Falls back to a neutral title. */
    host?: string;
}>): React.ReactElement {
    return (
        <SurfaceStateCard
            testID={`${props.testID}-loading`}
            kind="loading"
            // The host needs no translation and no sentence around it: the spinner already says
            // "loading", so the title's job is to say WHAT. One less string in twelve locales.
            title={props.host && props.host.length > 0 ? props.host : t('common.loading')}
            accessibilitySemantics="status"
        />
    );
}
