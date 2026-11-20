import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { UnconfirmedAccountUsageReset } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { t } from '@/text';

export function AccountUsageResetWait(props: Readonly<{
    onCancel: () => void;
    testID?: string;
}>) {
    const { testID } = props;
    return <SurfaceStateCard
        testID={testID ? `${testID}:waiting` : undefined}
        size="line"
        kind="loading"
        title={t('connectedServicesCollection.usageResetWaitExplanation')}
        accessibilitySemantics="status"
        action={{
            label: t('common.cancel'),
            testID: testID ? `${testID}:cancel-wait` : undefined,
            onPress: props.onCancel,
        }}
    />;
}

export function AccountUsageResetStatus(props: Readonly<{
    outcome: UnconfirmedAccountUsageReset;
    pending: boolean;
    onCheck: () => Promise<void>;
    testID?: string;
}>) {
    const { outcome, testID } = props;
    return <SurfaceStateCard
        testID={testID ? `${testID}:unknown` : undefined}
        size="line"
        kind="warning"
        title={t('connectedServicesCollection.usageResetOutcomeUnknown')}
        diagnosticCode={outcome.errorCode}
        accessibilitySemantics="status"
        action={{
            label: t('connectedServicesCollection.checkUsageResetOutcome'),
            testID: testID ? `${testID}:check` : undefined,
            busy: props.pending,
            disabled: props.pending,
            onPress: props.onCheck,
        }}
    />;
}
