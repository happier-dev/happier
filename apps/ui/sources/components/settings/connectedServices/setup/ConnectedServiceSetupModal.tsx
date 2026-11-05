import { ConnectedServiceSetupPanel, type ConnectedServiceSetupTarget } from './ConnectedServiceSetupPanel';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { StyleSheet } from 'react-native-unistyles';
import { View } from 'react-native';
import * as React from 'react';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { PluginUiOpenConnectedAccountsResultV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ConnectSheetKeyBindingTarget } from './connectSheetKeyBindings';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

import { ConnectSheetContent } from './ConnectSheetContent';

export type ConnectSheetAccountResult = Exclude<PluginUiOpenConnectedAccountsResultV1, undefined>;
export type ConnectSheetKeyResult = Readonly<{ kind: 'connected' | 'selected'; secretRef: string }>
    | Readonly<{ kind: 'dismissed' }>;
export type ConnectSheetAccountRequest = Readonly<{
    scope?: AccountSettingsScope | null;
    service?: PluginContributionIdentityV1;
    purpose?: QualifiedConnectedAccountPurposeV1;
    account?: QualifiedConnectedAccountRef;
    intent?: 'add' | 'reconnect';
    purposeRequest?: ConnectedAccountPurposeSetupRequest;
    /** Resource consumers keep their existing purpose-default writer; inline callers own the returned account. */
    purposeSettlement?: 'resourceDefault';
    initialMachineTarget?: MachineAdministrationTargetV1 | null;
    targetSelection?: MachineAdministrationTargetSelectionV1;
}>;
export type ConnectSheetKeyRequest = Readonly<{
    service: Readonly<{ kind: 'key'; suggestedName?: string; keyKind?: 'apiKey' | 'token' | 'password' | 'other' }>;
    scope?: AccountSettingsScope | null;
    current?: string;
    bindingTarget?: ConnectSheetKeyBindingTarget;
}>;
export type ConnectSheetRequest = ConnectSheetAccountRequest | ConnectSheetKeyRequest;
export type ConnectSheetResult = ConnectSheetAccountResult | ConnectSheetKeyResult;

export type ConnectSheetContentProps = CustomModalInjectedProps & Readonly<{
    request: ConnectSheetRequest;
    onResult: (result: ConnectSheetResult) => void;
}>;

/**
 * The setup panel where there is no page to grow in (lab AM/AMp): a popover's or a session banner's
 * "Sign in again", or Connect from a surface without room. Same panel, same controller; a modal on
 * wide screens and a sheet on phones through the modal owner.
 */
export function presentConnectSheet(request: ConnectSheetKeyRequest): Promise<ConnectSheetKeyResult>;
export function presentConnectSheet(request: ConnectSheetAccountRequest): Promise<ConnectSheetAccountResult>;
export function presentConnectSheet(request: ConnectSheetRequest): Promise<ConnectSheetResult> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const capturedRequest = request.scope === undefined ? { ...request, scope: lifetime?.scope ?? null } : request;
    return new Promise(resolve => {
        let modalId: string | null = null;
        let settled = false;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const finish = (result: ConnectSheetResult) => {
            if (settled) return;
            settled = true;
            retirement?.dispose();
            if (modalId) Modal.hide(modalId);
            resolve(result);
        };
        modalId = Modal.show({
            component: ConnectSheetContent,
            onRequestClose: () => finish({ kind: 'dismissed' }),
            onHostUnmount: () => finish({ kind: 'dismissed' }),
            props: { request: capturedRequest, onResult: finish },
            chrome: createAnchoredSheetChrome({ title: t('settings.connectedServices'),
                testID: 'connect-sheet' }),
            closeOnBackdrop: true,
        });
        if (!modalId) finish({ kind: 'dismissed' });
        else if (lifetime && areServerAccountScopesEqual(capturedRequest.scope, lifetime.scope)) {
            retirement = lifetime.onRetire(() => finish({ kind: 'dismissed' }));
            if (settled) retirement.dispose();
        }
    });
}

function ConnectedServiceSetupModalContent(props: CustomModalInjectedProps & Readonly<{
    initialTarget: ConnectedServiceSetupTarget;
}>) {
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached' });
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(indexModel), [indexModel]);
    const [target, setTarget] = React.useState(props.initialTarget);
    const { onClose } = props;
    return (
        <View style={styles.frame}>
            <ConnectedServiceSetupPanel
                testID="connected-service-setup-modal"
                chrome="card"
                target={target}
                catalog={catalog}
                onTargetChange={setTarget}
                onClose={onClose}
                onConnected={onClose}
            />
        </View>
    );
}

/**
 * The setup panel where there is no page to grow in (lab AM/AMp): a popover's or a session banner's
 * "Sign in again", or Connect from a surface without room. Same panel, same controller; a modal on
 * wide screens and a sheet on phones through the modal owner.
 */
export function openConnectedServiceSetupModal(target: ConnectedServiceSetupTarget): void {
    let modalId: string | null = null;
    const close = () => {
        if (!modalId) return;
        Modal.hide(modalId);
        modalId = null;
    };
    modalId = Modal.show({
        component: ConnectedServiceSetupModalContent,
        onRequestClose: close,
        props: { initialTarget: target },
    });
}

const styles = StyleSheet.create(() => ({
    frame: {
        width: '100%',
        maxWidth: 640,
        alignSelf: 'center',
    },
}));
