import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';

import { presentConnectedAccountIdentity, type ConnectedAccountIdentityPresenter } from '@/sync/domains/connectedServices/maskAccountEmail';
import { useActiveServerAccountScope, useLocalSetting } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { resolveConnectedServiceSettingsErrorMessage } from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import { Modal } from '@/modal';
import { t } from '@/text';

export type { ConnectedAccountIdentityInput, ConnectedAccountIdentityPresenter } from '@/sync/domains/connectedServices/maskAccountEmail';

/**
 * "Hide account emails and IDs" (device-local, off by default) and the one identity presenter every
 * surface renders connected-account identities through: rows, cards, the detail header, the Usage
 * popover, session usage and Home. `hidden` reads the setting; `present` applies
 * `presentConnectedAccountIdentity` with it, so no surface masks on its own.
 */
type ConnectedAccountIdentityPrivacyPresentation = Readonly<{
    hidden: boolean;
    present: ConnectedAccountIdentityPresenter;
}>;
type ConnectedAccountIdentityPrivacyMutation = ConnectedAccountIdentityPrivacyPresentation & Readonly<{
    setHidden: (hidden: boolean) => Promise<void>;
    execution: ReturnType<typeof useMountedActionExecution>;
}>;
export function useConnectedAccountIdentityPrivacy(): ConnectedAccountIdentityPrivacyPresentation;
export function useConnectedAccountIdentityPrivacy(options: Readonly<{ mutation: true }>): ConnectedAccountIdentityPrivacyMutation;
export function useConnectedAccountIdentityPrivacy(options?: Readonly<{ mutation: true }>): ConnectedAccountIdentityPrivacyMutation {
    const value = useLocalSetting('hideConnectedAccountIdentities');
    const scope = useActiveServerAccountScope();
    // Identity presentation is used per row; editing surfaces explicitly bind Action custody.
    const execution = useMountedActionExecution(options?.mutation ? scope : null);
    const setHidden = React.useCallback(async (hidden: boolean) => {
        if (!scope) return;
        try {
            const result = await execution.execute('connectedServices.identityPrivacy.set', { hidden });
            if (!result.ok && result.errorCode === 'action_account_scope_changed') return;
            if (!result.ok) throw createActionExecuteFailureError(result);
        } catch (error) {
            Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
        }
    }, [execution.execute, scope]);
    const hidden = value === true;
    const present = React.useCallback<ConnectedAccountIdentityPresenter>((input) => presentConnectedAccountIdentity({
        hidden,
        label: input.label ?? null,
        labelKind: input.labelKind,
        email: input.email ?? null,
        accountId: input.accountId ?? null,
    }), [hidden]);
    return React.useMemo(() => ({ hidden, setHidden, present, execution }), [hidden, present, setHidden, execution]);
}
