import * as React from 'react';

import { LostAccessView } from '@/components/account/restore/LostAccessView';

export const LostAccessEmbedded = React.memo(function LostAccessEmbedded() {
    return <LostAccessView returnTo="/" />;
});
