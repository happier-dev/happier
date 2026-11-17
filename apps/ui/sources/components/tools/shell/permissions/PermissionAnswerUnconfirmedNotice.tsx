import * as React from 'react';
import { HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import { log } from '@/log';
import { t } from '@/text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { SessionTranscriptActions } from '@/components/sessions/transcript/source/types';
import { clearPermissionAnswerUnconfirmedAfterPendingRead } from './permissionActionFailure';

/**
 * The one presentation of "the answer may already be applied" for permission footers and question cards.
 * "Check again" reads the exact request through the source's scoped reader. A request still waiting releases
 * transport uncertainty; a provider submission remains withheld until settlement; a settled one is published by the source and ends with its card; when the read cannot tell,
 * the answer stays unconfirmed and the notice says so.
 */
export function PermissionAnswerUnconfirmedNotice(props: Readonly<{
    requestKey: string;
    requestId: string;
    actions: SessionTranscriptActions | null;
    testIDPrefix: string;
}>) {
    const readOutcome = props.actions?.readRequestOutcome;
    const [checking, setChecking] = React.useState(false);
    const [couldNotCheck, setCouldNotCheck] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const checkAgain = async () => {
        if (!readOutcome || checking) return;
        setChecking(true);
        setCouldNotCheck(false);
        try {
            // A pending request resolves transport uncertainty, but a provider may still be applying a submitted answer.
            // Settled means the source already published the fresh Session; the card leaves the waiting
            // state with it, and the owning card ends the unconfirmed state then. Until it does, the
            // controls stay withheld, so a settled request is never offered another answer.
            if (await readOutcome(props.requestId) === 'pending') clearPermissionAnswerUnconfirmedAfterPendingRead(props.requestKey);
        } catch {
            log.log('[PermissionAnswerUnconfirmedNotice] request re-read failed');
            if (mounted.current) setCouldNotCheck(true);
        } finally {
            if (mounted.current) setChecking(false);
        }
    };

    // One state line (glyph · sentence · inline recovery), the same composition as every other in-list state: it
    // wraps on a narrow footer, announces itself, and "Check again" shows its own ring while the read runs. Its
    // hosts (a permission footer, a question card) draw their own edge, so the glyph stands on it.
    return (
        <HappierBodyEdgeContext.Provider value>
            <SurfaceStateCard
                testID={`${props.testIDPrefix}.answer-unconfirmed`}
                kind="warning"
                size="line"
                iconName="clock"
                accessibilitySemantics="alert"
                title={couldNotCheck ? t('errors.permissionCheckAgainFailed') : t('errors.permissionAnswerUnconfirmed')}
                action={readOutcome ? {
                    testID: `${props.testIDPrefix}.check-again`,
                    label: t('errors.permissionCheckAgain'),
                    busy: checking,
                    onPress: () => { void checkAgain(); },
                } : undefined}
            />
        </HappierBodyEdgeContext.Provider>
    );
}
