import * as React from 'react';
import { formatPairingCountdown } from '@/auth/pairing/pairingPresentation';
import { Text, type AppTextProps } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/** The expiry's only ticking leaf; the pairing panel itself never renders each second. */
export function PairingCountdown(props: Readonly<{ testID: string; expiresAtMs: number; style?: AppTextProps['style'] }>) {
    const [now, setNow] = React.useState(() => Date.now());
    const presented = useLayoutPresentationActive();
    useHostActivelyViewedEffect((activelyViewed) => {
        if (!activelyViewed || !presented) return;
        const current = Date.now();
        setNow(current);
        if (current >= props.expiresAtMs) return;
        const timer = setInterval(() => {
            const next = Date.now();
            setNow(next);
            if (next >= props.expiresAtMs) clearInterval(timer);
        }, 1000);
        return () => clearInterval(timer);
    }, [presented, props.expiresAtMs]);
    return <Text testID={props.testID} style={props.style}>
        {t('homeSetup.newCodeIn', { time: formatPairingCountdown(props.expiresAtMs, now) })}
    </Text>;
}
