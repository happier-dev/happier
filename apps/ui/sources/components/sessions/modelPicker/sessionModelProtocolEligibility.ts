import type { ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';
import type { ProviderBindingCompatibilityV1 } from '@happier-dev/protocol/providers/compatibility/v1';
import { isTeamCredentialProviderModelPickerValue, type SessionModelPickerOptionValue } from './sessionModelSelectionKey';

/** The admitted runner declaration narrows the Agent's otherwise compatible Provider offers. */
export function sessionModelProtocolEligible(
    protocols: readonly ProviderWireProtocol[] | undefined,
    compatibility: ProviderBindingCompatibilityV1 | null | undefined,
    selection: Exclude<SessionModelPickerOptionValue, null>,
): boolean {
    if (isTeamCredentialProviderModelPickerValue(selection)
        ? selection.deliveryMode === 'vendor-native'
        : 'providerConnectionId' in selection && selection.providerConnectionId === null) return true;
    return protocols === undefined || Boolean(compatibility && 'selectedProtocol' in compatibility
        && protocols.includes(compatibility.selectedProtocol));
}
