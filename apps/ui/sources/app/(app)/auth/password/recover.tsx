import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { E2eePasswordRecoveryScreen } from '@/components/account/auth/emailPassword/E2eePasswordRecoveryScreen';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { HostedSignedOutRouteContext, PASSWORD_RECOVERY_ROUTE } from '@/components/onboarding/preAuth/SignedOutRecoveryWorkflow';

/** Public exact-Home E2EE recovery-key password replacement entry. */
export default function E2eePasswordRecoveryRoute() {
    const params = useLocalSearchParams<{ target?: string | string[] }>();
    if (React.useContext(HostedSignedOutRouteContext) === PASSWORD_RECOVERY_ROUTE) return null;
    return <E2eePasswordRecoveryScreen homeTarget={firstRouteParam(params.target) || null} />;
}
