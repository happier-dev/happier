import * as React from 'react';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { ProviderConnectionUsageSection } from '@/components/settings/providers/ProviderConnectionUsageSection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { readConnectedAccountProviderUsageSources } from '@/providers/hooks/useProviderConnectionUsageForSource';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

export function QualifiedAccountProviderUsage(props: Readonly<{
    profile: Pick<QualifiedConnectedAccountProfileV4, 'ref' | 'credentialRevision' | 'configurationRevision' | 'kind'>;
    machineId: string | null;
    serverId: string;
    planLabel: string | null;
}>) {
    const presented = useLayoutPresentationActive();
    const enabled = useFeatureEnabled('providers', { scopeKind: 'spawn', serverId: props.serverId });
    const scope = useAccountSettingsScope();
    const active = presented && enabled && Boolean(props.machineId && scope
        && areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId));
    const [open, setOpen] = React.useState<string | null>(null);
    const declarations = useDaemonMergedProjectionInputs({
        machineId: props.machineId, serverId: props.serverId, sections: ['familiesById.providers'], enabled: active, load: open !== null,
    });
    const projection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 : null;
    const choices = React.useMemo(() => readConnectedAccountProviderUsageSources({
        account: props.profile.ref, credentialKind: props.profile.kind,
        context: projection ? providerDeclarationContext(props.machineId, projection) : { kind: 'account' },
    }), [props.profile.ref, props.profile.kind, props.machineId, projection]);
    if (!active || choices.length === 0) return null;
    const selected = choices.find(choice => choice.observationKey === open);
    const unavailable = declarations.phase === 'error' || declarations.phase === 'unsupported';
    return (
        <>
            <ItemGroup>
                {choices.map(choice => (
                    <Item key={choice.observationKey} testID="connected-account-provider-usage"
                        title={choice.providerName} subtitle={t('settings.usage')}
                        accessibilityState={{ expanded: choice.observationKey === open }}
                        onPress={() => setOpen(current => current === choice.observationKey ? null : choice.observationKey)}
                    />
                ))}
            </ItemGroup>
            {selected && !projection ? (
                <ItemGroup>
                    <SurfaceStateCard size="line" kind={unavailable ? 'empty' : 'loading'}
                        title={unavailable ? t('settingsProvidersCollection.usage.unsupported') : t('common.loading')} />
                </ItemGroup>
            ) : selected ? (
                <ProviderConnectionUsageSection
                    connectionId={selected.observationKey}
                    connectedAccountSource={selected.selected}
                    connectedAccountPlanLabel={props.planLabel}
                    identity={JSON.stringify([selected.declarationBasis, props.profile.credentialRevision, props.profile.configurationRevision])}
                    providerName={selected.providerName}
                    serverId={props.serverId}
                    scope={scope}
                    machineId={props.machineId}
                    sources={selected.sources}
                    secretBindings={undefined}
                    active
                    onChooseBillingKey={null}
                    onChooseApiKey={null}
                />
            ) : null}
        </>
    );
}
