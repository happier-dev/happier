import * as React from 'react';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { listConnectSheetKeyBindingRefs, type ConnectSheetKeyBindingTarget } from './connectSheetKeyBindings';

const NO_KEYS: readonly string[] = [];
const PLUGIN_KEYS = ['pluginSecretBindingsV1'] as const;
const VOICE_KEYS = ['voiceSettingsV1'] as const;

/** Demand only the existing metadata owner addressed by this Connect request. */
export function useConnectSheetKeyBindingRefs(target: ConnectSheetKeyBindingTarget | null | undefined,
    requestedScope?: AccountSettingsScope | null): Readonly<{ refs: readonly string[]; loading: boolean }> {
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const provider = useProviderCatalog(target?.kind === 'provider' ? scope : null,
        { enabled: target?.kind === 'provider' && Boolean(scope) });
    const providerConnections = provider?.data ?? null;
    const configurations = useConnectedAccountCatalog('configurations', target?.kind === 'service' ? scope : null,
        { enabled: target?.kind === 'service' && Boolean(scope) });
    const settingsTarget = areServerAccountScopesEqual(scope, activeScope) ? target : null;
    const settings = useSettingsValues(settingsTarget?.kind === 'plugin' ? PLUGIN_KEYS
        : settingsTarget?.kind === 'voice' ? VOICE_KEYS : NO_KEYS);
    const refs = React.useMemo(() => !target || !scope ? []
        : (target.kind === 'plugin' || target.kind === 'voice') && !settingsTarget ? []
        : listConnectSheetKeyBindingRefs({ target, settings, providerConnections, connectedConfigurations: configurations.value }),
    [target, scope, settingsTarget, settings, providerConnections, configurations.value]);
    const loading = Boolean(scope && (target?.kind === 'provider'
        ? !providerConnections && (!provider || provider.status === 'loading')
        : target?.kind === 'service' && !configurations.value && configurations.status === 'loading'));
    return { refs, loading };
}
