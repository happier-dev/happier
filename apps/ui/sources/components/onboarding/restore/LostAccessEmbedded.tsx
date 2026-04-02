import * as React from 'react';

import { LostAccessView } from '@/components/account/restore/LostAccessView';

export type LostAccessEmbeddedProps = Readonly<{
    onBack: () => void;
}>;

export const LostAccessEmbedded = React.memo(function LostAccessEmbedded(props: LostAccessEmbeddedProps) {
    return (
        <LostAccessView
            embedded
            returnTo="/"
            onBack={props.onBack}
        />
    );
});

