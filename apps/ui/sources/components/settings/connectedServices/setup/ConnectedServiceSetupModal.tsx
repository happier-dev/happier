import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { ConnectSheetKeyBindingTarget } from './connectSheetKeyBindings';
import type { DaemonNpmRegistryProfileSnapshotV1 } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import type { PluginUiOpenConnectedAccountsResultV1 } from '@happier-dev/protocol/plugins/ui/client';

import { ConnectSheetContent } from './ConnectSheetContent';
import { createConnectSheetChrome } from './connectSheetChrome';
import { resolveConnectSheetBodyScroll } from './connectSheetOpening';
import type { ConnectedAccountSetupFacts } from '../account/useConnectedAccountSetupCompletion';

export type ConnectSheetAccountResult = Exclude<PluginUiOpenConnectedAccountsResultV1, undefined> & ConnectedAccountSetupFacts;
export type ConnectSheetKeyResult = Readonly<{ kind: 'connected' | 'selected'; secretRef: string }>
    | Readonly<{ kind: 'dismissed' }>;
export type ConnectSheetAccountRequest = Readonly<{
    scope?: AccountSettingsScope | null;
    service?: PluginContributionIdentityV1;
    purpose?: QualifiedConnectedAccountPurposeV1;
    account?: QualifiedConnectedAccountRef;
    /**
     * Why the caller opens the sheet, decided by its entry point: `add` (Credentials' and a service's "+") offers
     * only the new-account form; `link` (a setting, Agent or binding that needs a credential) offers existing
     * accounts first; `reconnect` signs `account` in again.
     */
    intent: 'add' | 'link' | 'reconnect';
    purposeRequest?: ConnectedAccountPurposeSetupRequest;
    /** Resource consumers keep their existing purpose-default writer; inline callers own the returned account. */
    purposeSettlement?: 'resourceDefault';
    initialMachineTarget?: MachineAdministrationTargetV1 | null;
    targetSelection?: MachineAdministrationTargetSelectionV1;
    /** Why the caller needs the account, said in the band in place of which agents use it (Previews: its pull requests). */
    reason?: string;
    /** A use no agent signs in for leads with the service's declared default method, not the agent sign-in ranking. */
    methodOrder?: 'declaredDefault';
}>;
export type ConnectSheetKeyRequest = Readonly<{
    service: Readonly<{ kind: 'key'; suggestedName?: string; keyKind?: 'apiKey' | 'token' | 'password' | 'other' }>;
    /** `add` makes a new key (Credentials' "+"); `link` binds one to something and offers the saved keys too. */
    intent: 'add' | 'link';
    scope?: AccountSettingsScope | null;
    current?: string;
    bindingTarget?: ConnectSheetKeyBindingTarget;
    /** A typed credential's storage review precedes submission in the shared editor. */
    confirmTypedValueStorage?: () => Promise<boolean>;
}>;
export type ConnectSheetNpmRegistryRequest = Readonly<{
    service: Readonly<{ kind: 'npm-registry-profile' }>;
    scope?: AccountSettingsScope | null;
    current?: string;
    projectDir?: string;
    targetSelection?: MachineAdministrationTargetSelectionV1;
    onOperationError?: (code: string) => void;
}>;
export type ConnectSheetNpmRegistryResult = Readonly<{
    kind: 'connected' | 'selected';
    profile: DaemonNpmRegistryProfileSnapshotV1['profiles'][number];
}> | Readonly<{ kind: 'dismissed' }>;
export type ConnectSheetRequest = ConnectSheetAccountRequest | ConnectSheetKeyRequest | ConnectSheetNpmRegistryRequest;
export type ConnectSheetResult = ConnectSheetAccountResult | ConnectSheetKeyResult | ConnectSheetNpmRegistryResult;

export type ConnectSheetContentProps = CustomModalInjectedProps & Readonly<{
    request: ConnectSheetRequest;
    onResult: (result: ConnectSheetResult) => void;
}>;

/**
 * The setup panel where there is no page to grow in (lab AM/AMp): a popover's or a session banner's
 * "Sign in again", or Connect from a surface without room. Same panel, same controller; one presentation
 * for every caller ({@link createConnectSheetChrome}).
 */
export function presentConnectSheet(request: ConnectSheetKeyRequest): Promise<ConnectSheetKeyResult>;
export function presentConnectSheet(request: ConnectSheetNpmRegistryRequest): Promise<ConnectSheetNpmRegistryResult>;
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
            // The body scroll its content publishes with its heading: a native card picks its body once, here.
            chrome: { ...createConnectSheetChrome({ title: t('settings.connectedServices'), testID: 'connect-sheet' }),
                bodyScroll: resolveConnectSheetBodyScroll(request) },
            closeOnBackdrop: true,
        });
        if (!modalId) finish({ kind: 'dismissed' });
        else if (lifetime && areServerAccountScopesEqual(capturedRequest.scope, lifetime.scope)) {
            retirement = lifetime.onRetire(() => finish({ kind: 'dismissed' }));
            if (settled) retirement.dispose();
        }
    });
}
