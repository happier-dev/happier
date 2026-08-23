import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * The non-framable web fallback (§3.4): shown when the engine's load-vs-timeout heuristic concludes
 * a site refuses embedding. The body message is sourced via the OWNER-COPY mapper
 * ({@link resolveReasonCopy}) so no raw reason code renders; the "open in system browser" action is
 * the fulfilled escape hatch ({@link openBrowserExternalTabSelection} → `openExternalUrl`), wired by
 * the caller. Never a silent blank/"No view".
 *
 * It renders through {@link SurfaceStateCard} — the ONE terminal-state card — rather than the
 * hand-rolled stack it used to be. That stack painted `button.primary.tint` on `accent.indigo`,
 * which is **2.07:1 in dark theme** (AA needs 4.5) on the ONLY action this surface offers, and it
 * set a bare `fontWeight:'600'` that renders regular wherever the named Inter face is used. The
 * card's `RoundButton` measures 21:1 light / 7.1:1 dark, and the state transition is announced
 * because the card owns a live region.
 */
export function BrowserFrameNonFramable(props: Readonly<{
    testID: string;
    onOpenInSystemBrowser: () => void;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: 'external_url_unavailable', kind: 'browserFrame' });
    return (
        <SurfaceStateCard
            testID={`${props.testID}-non-framable`}
            kind="unavailable"
            iconName="arrow-square-out"
            title={t('browserShell.nonFramable.title')}
            reason={copy.message}
            diagnosticCode={copy.diagnosticCode}
            accessibilitySemantics="status"
            action={{
                label: t('browserShell.nonFramable.openInSystemBrowser'),
                onPress: props.onOpenInSystemBrowser,
            }}
        />
    );
}
