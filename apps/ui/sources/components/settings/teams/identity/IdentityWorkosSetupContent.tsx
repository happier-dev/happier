import * as React from 'react';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { HOME_WORKOS_SETUP_SETTINGS, TEAM_WORKOS_SETUP_SETTINGS } from './teamAuthenticationSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { useIdentityAdministration } from './useIdentityAdministration';
import { eligibleProviderUnavailableReason } from './eligibleProviderAvailability';
import { t } from '@/text';

/** One draft-creation entry for the Home and Team scopes, using the same server-owned eligibility. */
export function IdentityWorkosSetupContent(props: Readonly<{
    scope: ServerAccountScope;
    teamId: string | null;
    homeName?: string;
    conditionBanners?: React.ReactNode;
    mutationsAvailable: boolean;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    onCreated: (connectionId: string) => void;
}>) {
    const { state, refresh } = useIdentityAdministration(props.scope, props.teamId, props.requestApproval);
    const client = React.useMemo(() => createIdentityAdministrationClient(props.scope, { onApprovalPending: props.requestApproval }), [props.scope.serverId, props.scope.accountId, props.requestApproval]);
    const [displayName, setDisplayName] = React.useState('');
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const choice = state.kind === 'ready' ? state.eligibleProviders.find((provider) => provider.providerKind === 'workos_sso' && provider.providerId === null) : undefined;
    const eligible = choice?.availability.status === 'available' && choice.availability.setupChoice.kind === 'create_managed';
    const canCreate = props.mutationsAvailable && state.kind === 'ready' && !state.refreshing && !state.stale && eligible;
    const create = async () => {
        if (!canCreate || pending || !displayName.trim()) return;
        setPending(true); setFailure(null);
        try {
            const result = await client.execute('teams.identity.workos.connection.create', { v: 1, teamId: props.teamId, displayName: displayName.trim() }, {
                onApprovalSucceeded: (value) => props.onCreated(value.connection.id),
                onApprovalFailed: setFailure,
            });
            if (result.ok) props.onCreated(result.value.connection.id);
            else if (!('approvalPending' in result)) setFailure(result.failure.code);
        } catch { setFailure('home_unreachable'); }
        finally { setPending(false); }
    };
    const settings = props.teamId === null ? HOME_WORKOS_SETUP_SETTINGS : TEAM_WORKOS_SETUP_SETTINGS;
    return <><PageHeader title={t('identityAdministration.homeWorkosAdd')} description={props.teamId === null ? t('identityAdministration.homeWorkosPurpose') : t('identityAdministration.workosStepPortalDetail')} />
        {props.conditionBanners}
        <SettingSection section={settings.sectionRefs.configuration}><ItemGroup>
        {state.kind === 'loading' ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
        {state.kind === 'unavailable' ? <SurfaceStateCard kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined} /> : null}
        {state.kind === 'ready' && !eligible ? <SurfaceStateCard kind="unavailable" size="line" title={choice ? eligibleProviderUnavailableReason(choice, props.homeName ?? '', t('identityAdministration.homeWorkosAdd')) ?? t('identityAdministration.errorSetupRequired') : t('identityAdministration.errorSetupRequired')} /> : null}
        {state.kind === 'ready' && state.failure ? <SurfaceStateCard kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={{ label: t('common.retry'), onPress: refresh }} /> : null}
        <SettingRow setting={settings.settings.companyName} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="identity-workos-company-name" accessibilityLabel={t('identityAdministration.homeWorkosCompanyName')} value={displayName} editable={canCreate && !pending} onChangeText={setDisplayName} autoCapitalize="words" />} />
        {failure ? <SurfaceStateCard testID="identity-workos-create-failure" kind="error" size="line" title={identityAdministrationFailureMessage(failure)} /> : null}
        <SectionContentRow showDivider={false}><SectionButtonRow><SettingAnchor setting={settings.settings.create}><RoundButton testID="identity-workos-create" title={t('identityAdministration.add')} loading={pending} disabled={!canCreate || !displayName.trim()} onPress={() => void create()} /></SettingAnchor></SectionButtonRow></SectionContentRow>
    </ItemGroup></SettingSection></>;
}
