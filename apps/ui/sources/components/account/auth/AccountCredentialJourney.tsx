import * as React from 'react';
import { prepareAccountCredentialJourney, type AccountCredentialJourney as JourneyRequest } from '@/auth/flows/accountCredentialJourney';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** Do not mount a secret form until the journey is in its owning realm. */
type AccountCredentialJourneyProps = Readonly<{
    request: JourneyRequest | null;
    children: React.ReactNode;
}>;

export function AccountCredentialJourney(props: AccountCredentialJourneyProps): React.ReactElement {
    return <AccountCredentialJourneyBody key={JSON.stringify(props.request)} {...props} />;
}

function AccountCredentialJourneyBody(props: AccountCredentialJourneyProps): React.ReactElement {
    const [move] = React.useState(() => props.request ? prepareAccountCredentialJourney(props.request) : null);
    const [state, setState] = React.useState<'pending' | 'moved' | 'failed'>('pending');
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        if (!move) return;
        let mounted = true;
        setState('pending');
        void move().then(() => { if (mounted) setState('moved'); }, () => { if (mounted) setState('failed'); });
        return () => { mounted = false; };
    }, [attempt, move]);
    if (!move) return <>{props.children}</>;
    return <SurfaceStateCard
        testID="account-credential-journey"
        kind={state === 'pending' ? 'loading' : state === 'failed' ? 'unavailable' : 'empty'}
        title={state === 'pending' ? t('common.loading') : state === 'failed' ? t('errors.operationFailed') : t('common.done')}
        {...(state === 'failed' ? { action: { label: t('common.retry'), onPress: () => setAttempt(value => value + 1) } } : {})}
        accessibilitySemantics="status"
    />;
}
