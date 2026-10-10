import * as React from 'react';
import {
    HomeTeamProviderPolicyV1Schema,
    type HomeIdentityNetworkPolicyV1,
    type HomeTeamProviderPolicyV1,
    type ManagedIdentityProviderKindV1,
} from '@happier-dev/protocol/home/governance';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { setHomeAuthenticationPolicies } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import { homeAdministrationServerSettingsPath } from '../governance/homeAdministrationRoutes';
import { HomeDeploymentFixedNote } from '../governance/HomeDeploymentFixedNote';
import { homeGovernanceFailureNotice } from '../governance/homeGovernanceLabels';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from './homeSignInProvidersSettings';

/** The deployment key that permits private identity endpoints at all (the Home can only narrow it). */
export const PRIVATE_NETWORK_CEILING_KEY = 'HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED';

const TEAM_PROVIDER_KINDS: readonly ManagedIdentityProviderKindV1[] = [
    'workos_sso',
    'oidc',
    'github_app_identity',
];

function teamProviderKindLabel(kind: ManagedIdentityProviderKindV1): string {
    switch (kind) {
        case 'workos_sso': return 'WorkOS';
        case 'oidc': return 'OpenID Connect';
        case 'github_app_identity': return 'GitHub';
    }
}

/** The one mode choice answers a search for either of its two settings. */
const NETWORK_MODE_SETTINGS = [
    HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.publicOnly,
    HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.privateAllowlist,
];

/** One list entry per line, so a pasted allowlist survives unchanged. */
function readLines(value: string): readonly string[] {
    return value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

type IdentityNetworkDraft = Readonly<{
    mode: HomeIdentityNetworkPolicyV1['mode'];
    hostnames: string;
    cidrs: string;
    ports: string;
}>;

function identityNetworkDraftFromPolicy(policy: HomeIdentityNetworkPolicyV1 | null): IdentityNetworkDraft {
    if (!policy || policy.mode === 'public_only') {
        return { mode: policy?.mode ?? 'public_only', hostnames: '', cidrs: '', ports: '' };
    }
    return {
        mode: 'private_allowlist',
        hostnames: policy.hostnames.join('\n'),
        cidrs: policy.cidrs.join('\n'),
        ports: policy.ports.join('\n'),
    };
}

/**
 * The draft as the Home's own policy value, or `null` when it is not one yet.
 *
 * Shape is decided here so an obviously incomplete allowlist never reaches the
 * network; the Home still validates and remains the deciding authority.
 */
function identityNetworkPolicyFromDraft(draft: IdentityNetworkDraft): HomeIdentityNetworkPolicyV1 | null {
    if (draft.mode === 'public_only') return { v: 1, mode: 'public_only' };
    const hostnames = [...new Set(readLines(draft.hostnames))];
    const cidrs = [...new Set(readLines(draft.cidrs))];
    const ports = [...new Set(readLines(draft.ports).map((port) => Number(port)))];
    if (hostnames.length === 0 && cidrs.length === 0) return null;
    if (ports.length === 0) return null;
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) return null;
    return { v: 1, mode: 'private_allowlist', hostnames, cidrs, ports };
}

/**
 * Where managed sign-in may reach: public endpoints only, or an exact private allowlist inside the
 * deployment's ceiling. Where the deployment does not permit private endpoints the section still
 * says so, with the key that decides it and whether the deployment fixed it, instead of vanishing.
 * When the Home does not report these facts at all the section stays away rather than inventing a
 * deployment answer the server never gave.
 */
export const HomePrivateEndpointsSection = React.memo(function HomePrivateEndpointsSection(
    props: Readonly<{
        context: HomeAdministrationContext;
        ceilingFixed: boolean | null;
        /** Where this Home turns private endpoints on (its row on Features), when it can. */
        ceilingHref?: string | null;
    }>,
) {
    const { context } = props;
    const router = useRouter();
    const services = context.projection.identityServices;
    const networkRead = context.projection.policy.identityNetwork;
    const committed = networkRead?.status === 'narrowed' ? networkRead.policy : null;
    const [draft, setDraft] = React.useState<IdentityNetworkDraft | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [invalid, setInvalid] = React.useState(false);
    const operationInFlightRef = React.useRef<symbol | null>(null);
    // The draft the administrator has typed so far, readable from an event
    // handler that has not re-rendered yet. Editing three fields and pressing
    // Save in the same beat must submit all three, not the last one over an
    // empty list.
    const draftRef = React.useRef<IdentityNetworkDraft | null>(null);
    React.useEffect(() => {
        // A route changing Homes is a different authority and policy document;
        // only a refresh of this same exact Home is allowed to retain the draft.
        draftRef.current = null;
        operationInFlightRef.current = null;
        setDraft(null);
        setInvalid(false);
    }, [context.scope.serverId, context.scope.accountId]);

    if (!services) return null;
    const editable = context.projection.capabilities.manageAuthentication && context.mutationsAvailable;
    const current = draft ?? identityNetworkDraftFromPolicy(committed);
    const patch = (values: Partial<IdentityNetworkDraft>) => {
        const next = { ...(draftRef.current ?? identityNetworkDraftFromPolicy(committed)), ...values };
        draftRef.current = next;
        setInvalid(false);
        setDraft(next);
    };

    const discard = () => {
        draftRef.current = null;
        setInvalid(false);
        setDraft(null);
    };

    const save = async () => {
        if (operationInFlightRef.current !== null) return;
        const policy = identityNetworkPolicyFromDraft(
            draftRef.current ?? identityNetworkDraftFromPolicy(committed),
        );
        if (!policy) { setInvalid(true); return; }
        const operationIdentity = Symbol('identity-network-policy');
        operationInFlightRef.current = operationIdentity;
        setInvalid(false);
        setSaving(true);
        try {
            const outcome = await setHomeAuthenticationPolicies({
                scope: context.scope,
                expectedRevision: context.projection.policy.revision,
                identityNetworkPolicy: policy,
            });
            if (operationInFlightRef.current !== operationIdentity) return;
            if (outcome.kind === 'succeeded') {
                // The mutation owner has already refreshed this exact Home by
                // the time it returns. Adopt that committed value and leave no
                // stale local editor state behind.
                draftRef.current = null;
                setDraft(null);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            if (outcome.kind === 'failed' && outcome.failure.code === 'home_policy_revision_conflict') {
                await Modal.alertAsync(
                    t('homeGovernance.revisionConflictTitle'),
                    t('homeGovernance.revisionConflictBody'),
                );
                context.refresh();
                return;
            }
            // The Home's own verdict, not one generic sentence: a save whose
            // answer was lost must not be reported as a save that did not happen.
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
        } finally {
            if (operationInFlightRef.current === operationIdentity) {
                operationInFlightRef.current = null;
                setSaving(false);
            }
        }
    };

    return (
        <>
            {!services.privateIdentityNetworkAllowed ? (
                <ItemGroup title={t('homeGovernance.signInProviders.privateEndpointsTitle')} description={t('homeGovernance.privateEndpointsDescription')}>
                    {/* Fixed: the shared deployment note. Off on this Home: where it is turned on (DR-03/DR-17). */}
                    {props.ceilingFixed ? (
                        <Item
                            testID="home-sign-in-private-endpoints-unavailable"
                            title={t('homeGovernance.privateEndpointsPublicOnly')}
                            subtitleAccessory={<HomeDeploymentFixedNote keys={[PRIVATE_NETWORK_CEILING_KEY]} testID="home-sign-in-private-endpoints-unavailable" />}
                            mode="info"
                            showChevron={false}
                        />
                    ) : (
                        <Item
                            testID="home-sign-in-private-endpoints-unavailable"
                            title={t('homeGovernance.privateEndpointsPublicOnly')}
                            subtitle={t('homeGovernance.signInProviders.privateEndpointsOffHere')}
                            // Its row on Features when the Home reports one; else the page that lists every key.
                            detail={props.ceilingHref ? t('homeGovernance.features.title') : t('homeSettings.page.title')}
                            onPress={() => router.push((props.ceilingHref ?? homeAdministrationServerSettingsPath(context.scope.serverId)) as never)}
                        />
                    )}
                </ItemGroup>
            ) : (
                <ItemGroup
                    title={t('homeGovernance.signInProviders.privateEndpointsTitle')}
                    description={networkRead?.status === 'unreadable'
                        ? t('homeGovernance.privateEndpointsUnreadable')
                        : invalid
                            ? t('homeGovernance.privateEndpointsInvalid')
                            : t('homeGovernance.privateEndpointsDescription')}
                >
                    {/* One decision, both answers visible; the line under it says what the chosen one means (lab `hcSignin-RA`). */}
                    <SettingAnchor settings={NETWORK_MODE_SETTINGS}><SegmentedChoiceItem<HomeIdentityNetworkPolicyV1['mode']>
                        testID="home-policy-identity-network-mode"
                        testIDPrefix="home-policy-identity-network-mode"
                        title={t('homeGovernance.privateEndpoints')}
                        subtitleLines={0}
                        options={[
                            {
                                id: 'public_only',
                                label: t('homeGovernance.signInProviders.privateEndpointsPublicOnlyShort'),
                                description: t('homeGovernance.signInProviders.privateEndpointsPublicOnlyHint'),
                            },
                            {
                                id: 'private_allowlist',
                                label: t('homeGovernance.signInProviders.privateEndpointsAllowlistShort'),
                                description: t('homeGovernance.signInProviders.privateEndpointsAllowlistHint'),
                            },
                        ]}
                        value={current.mode}
                        onChange={(mode) => patch({ mode })}
                        disabled={!editable || saving}
                    /></SettingAnchor>
                    {current.mode === 'private_allowlist' ? (
                        <>
                            <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.hostnames}><Item title={t('homeGovernance.privateEndpointsHostnames')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="home-policy-identity-network-hostnames" accessibilityLabel={t('homeGovernance.privateEndpointsHostnames')} value={current.hostnames} editable={editable && !saving} multiline autoCapitalize="none" onChangeText={(value) => patch({ hostnames: value })} />} /></SettingAnchor>
                            <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.cidrs}><Item title={t('homeGovernance.privateEndpointsCidrs')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="home-policy-identity-network-cidrs" accessibilityLabel={t('homeGovernance.privateEndpointsCidrs')} value={current.cidrs} editable={editable && !saving} multiline autoCapitalize="none" onChangeText={(value) => patch({ cidrs: value })} />} /></SettingAnchor>
                            <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.ports}><Item title={t('homeGovernance.privateEndpointsPorts')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="home-policy-identity-network-ports" accessibilityLabel={t('homeGovernance.privateEndpointsPorts')} value={current.ports} editable={editable && !saving} multiline keyboardType="number-pad" onChangeText={(value) => patch({ ports: value })} />} /></SettingAnchor>
                        </>
                    ) : null}
                    {editable ? (
                        <SectionContentRow showDivider={false}>
                            <SectionButtonRow
                                trailing={(
                                    <>
                                        <RoundButton
                                            testID="home-policy-identity-network-cancel"
                                            size="small"
                                            display="inverted"
                                            title={t('common.cancel')}
                                            disabled={draft === null || saving}
                                            onPress={discard}
                                        />
                                        <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.saveNetwork}><RoundButton
                                            testID="home-policy-identity-network-save"
                                            size="small"
                                            title={t('common.save')}
                                            loading={saving}
                                            disabled={draft === null || saving}
                                            onPress={() => { void save(); }}
                                        /></SettingAnchor>
                                    </>
                                )}
                            >
                                {null}
                            </SectionButtonRow>
                        </SectionContentRow>
                    ) : null}
                </ItemGroup>
            )}
        </>
    );
});

/**
 * Team sign-in rules: which provider kinds Teams may bring, automatic membership from sign-in, and
 * the approved GitHub Enterprise hosts. It edits the Home-wide Team provider ceiling through the
 * same revision-guarded policy owner as the rest of Home governance.
 *
 * An inherited (or unreadable) policy is edited from the deployment ceiling the
 * Home projects (`identityServices.teamProviderKinds`): inheritance means "every
 * kind this deployment can run", with Team JIT and GitHub Enterprise origins off
 * until the Home explicitly allows them. The first save writes the narrowing.
 * Kinds the deployment cannot run can be removed but never added.
 */
export const HomeTeamSignInRulesSection = React.memo(function HomeTeamSignInRulesSection(
    props: Readonly<{ context: HomeAdministrationContext }>,
) {
    const { context } = props;
    const providerRead = context.projection.policy.teamProviders;
    const [draft, setDraft] = React.useState<Readonly<{
        allowedTeamProviderKinds?: readonly ManagedIdentityProviderKindV1[];
        teamJitAllowed?: boolean;
    }> | null>(null);
    const [originsDraft, setOriginsDraft] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState<ManagedIdentityProviderKindV1 | 'jit' | 'origins' | null>(null);
    const approvalPending = context.approvalPending;
    const [approvalChange, setApprovalChange] = React.useState<Readonly<{
        changed: ManagedIdentityProviderKindV1 | 'jit';
        observedPending: boolean;
    }> | null>(null);
    const operationInFlightRef = React.useRef<symbol | null>(null);

    const discardOptimisticChange = React.useCallback((changed: ManagedIdentityProviderKindV1 | 'jit' | 'origins') => {
        // Origins are an explicit text draft with an explicit Save action. A
        // rejected automatic checkbox mutation must not erase that unrelated
        // authored text, and an origins refusal deliberately leaves it ready
        // for correction/retry.
        if (changed === 'origins') return;
        setDraft((current) => {
            if (!current) return current;
            const next = { ...current };
            if (changed === 'jit') delete next.teamJitAllowed;
            else delete next.allowedTeamProviderKinds;
            return Object.keys(next).length > 0 ? next : null;
        });
    }, []);

    React.useEffect(() => {
        operationInFlightRef.current = null;
        setDraft(null);
        setOriginsDraft(null);
        setPending(null);
        setApprovalChange(null);
    }, [context.scope.serverId, context.scope.accountId]);

    const ceilingKinds = context.projection.identityServices?.teamProviderKinds ?? null;
    const committed: HomeTeamProviderPolicyV1 | null = providerRead?.status === 'narrowed'
        ? providerRead.policy
        : providerRead && ceilingKinds
            ? {
                v: 1,
                allowedTeamProviderKinds: [...ceilingKinds],
                teamJitAllowed: false,
                approvedGitHubEnterpriseOrigins: [],
            }
            : null;
    const committedKey = committed ? JSON.stringify(committed) : '';
    React.useEffect(() => {
        setDraft((current) => {
            if (!current) return current;
            if (!committed) return null;
            const next = {
                ...(current.allowedTeamProviderKinds
                    && JSON.stringify(current.allowedTeamProviderKinds)
                        !== JSON.stringify(committed.allowedTeamProviderKinds)
                    ? { allowedTeamProviderKinds: current.allowedTeamProviderKinds }
                    : {}),
                ...(current.teamJitAllowed !== undefined
                    && current.teamJitAllowed !== committed.teamJitAllowed
                    ? { teamJitAllowed: current.teamJitAllowed }
                    : {}),
            };
            return Object.keys(next).length > 0 ? next : null;
        });
        setOriginsDraft((current) => {
            if (current === null) return current;
            if (!committed) return null;
            const candidate = HomeTeamProviderPolicyV1Schema.safeParse({
                ...committed,
                approvedGitHubEnterpriseOrigins: readLines(current),
            });
            return candidate.success
                && JSON.stringify(candidate.data.approvedGitHubEnterpriseOrigins)
                    === JSON.stringify(committed.approvedGitHubEnterpriseOrigins)
                ? null
                : current;
        });
    }, [committedKey]);

    // The shell is the approval lifecycle owner. The checkbox candidate is
    // shown while that artifact is genuinely pending, then discarded when the
    // shell reports a terminal outcome. On executed success the shell refreshes
    // the same Home, so the next render adopts the authoritative committed
    // policy rather than preserving this optimistic candidate as local truth.
    React.useEffect(() => {
        if (!approvalChange) return;
        if (approvalPending) {
            if (!approvalChange.observedPending) {
                setApprovalChange({ ...approvalChange, observedPending: true });
            }
            return;
        }
        if (!approvalChange.observedPending) return;
        discardOptimisticChange(approvalChange.changed);
        setApprovalChange(null);
    }, [approvalChange, approvalPending, discardOptimisticChange]);

    const selected = committed && draft ? { ...committed, ...draft } : committed;
    const editable = context.projection.capabilities.manageAuthentication && context.mutationsAvailable;

    const save = React.useCallback(async (
        next: HomeTeamProviderPolicyV1,
        changed: ManagedIdentityProviderKindV1 | 'jit' | 'origins',
    ) => {
        if (operationInFlightRef.current !== null) return;
        const operationIdentity = Symbol('team-provider-policy');
        operationInFlightRef.current = operationIdentity;
        setPending(changed);
        try {
            const outcome = await setHomeAuthenticationPolicies({
                scope: context.scope,
                expectedRevision: context.projection.policy.revision,
                teamProviderPolicy: next,
            });
            if (operationInFlightRef.current !== operationIdentity) return;
            if (outcome.kind === 'succeeded') {
                setApprovalChange(null);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                if (!context.requestApproval) {
                    // Without a shell lifecycle owner there is no truthful
                    // pending state to retain. Explicit text remains available
                    // to retry, while automatic toggles return to committed.
                    discardOptimisticChange(changed);
                    return;
                }
                if (changed !== 'origins') {
                    setApprovalChange({ changed, observedPending: context.approvalPending });
                }
                context.requestApproval(outcome.artifactId);
                return;
            }
            discardOptimisticChange(changed);
            if (outcome.kind === 'failed' && outcome.failure.code === 'home_policy_revision_conflict') {
                await Modal.alertAsync(
                    t('homeGovernance.revisionConflictTitle'),
                    t('homeGovernance.revisionConflictBody'),
                );
                context.refresh();
                return;
            }
            // The Home's own verdict, not one generic sentence: a save whose
            // answer was lost must not be reported as a save that did not happen.
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
        } finally {
            if (operationInFlightRef.current === operationIdentity) {
                operationInFlightRef.current = null;
                setPending(null);
            }
        }
    }, [context, discardOptimisticChange]);

    const toggleProvider = React.useCallback((kind: ManagedIdentityProviderKindV1) => {
        if (!selected || pending !== null) return;
        const enabled = selected.allowedTeamProviderKinds.includes(kind);
        const allowedTeamProviderKinds = TEAM_PROVIDER_KINDS.filter((candidate) => (
            candidate === kind ? !enabled : selected.allowedTeamProviderKinds.includes(candidate)
        ));
        setDraft((current) => ({ ...current, allowedTeamProviderKinds }));
        void save({ ...selected, allowedTeamProviderKinds }, kind);
    }, [pending, save, selected]);

    const toggleJit = React.useCallback(() => {
        if (!selected || pending !== null) return;
        const teamJitAllowed = !selected.teamJitAllowed;
        setDraft((current) => ({ ...current, teamJitAllowed }));
        void save({
            ...selected,
            allowedTeamProviderKinds: [...selected.allowedTeamProviderKinds],
            teamJitAllowed,
        }, 'jit');
    }, [pending, save, selected]);

    const originsText = originsDraft
        ?? selected?.approvedGitHubEnterpriseOrigins.join('\n')
        ?? '';
    const originsCandidate = selected
        ? HomeTeamProviderPolicyV1Schema.safeParse({
            ...selected,
            approvedGitHubEnterpriseOrigins: readLines(originsText),
        })
        : null;
    const originsValid = originsCandidate?.success === true;
    const saveOrigins = React.useCallback(() => {
        if (!originsCandidate?.success || originsDraft === null || pending !== null) return;
        void save(originsCandidate.data, 'origins');
    }, [originsCandidate, originsDraft, pending, save]);

    if (!providerRead) return null;

    if (providerRead.status === 'inherited' && !committed) {
        return (
            <>
                <ItemGroup title={t('homeGovernance.signInProviders.teamRules')} description={t('homeGovernance.authInheritedDescription')}>
                    <SurfaceStateCard testID="home-policy-team-providers-inherited" kind="empty" size="line" title={t('homeGovernance.authInherited')} />
                </ItemGroup>
            </>
        );
    }

    if (providerRead.status === 'unreadable' && !committed) {
        return (
            <>
                <ItemGroup title={t('homeGovernance.signInProviders.teamRules')} description={t('homeGovernance.authUnreadableDescription')}>
                    <SurfaceStateCard testID="home-policy-team-providers-unreadable" kind="error" size="line" title={t('homeGovernance.authUnreadable')} />
                </ItemGroup>
            </>
        );
    }

    return (
        <>
            <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.allowedTeamProviderKinds}><ItemGroup
                title={t('homeGovernance.signInProviders.teamRules')}
                description={editable
                    ? (providerRead.status === 'inherited'
                        ? t('homeGovernance.authInheritedDescription')
                        : providerRead.status === 'unreadable'
                            ? t('homeGovernance.authUnreadableDescription')
                            : t('homeGovernance.signInProviders.teamRulesDescription'))
                    : (
                        context.mutationsAvailable
                            ? t('homeGovernance.policyReadOnly')
                            : t('homeGovernance.signInProviders.teamRulesDescription')
                    )}
            >
                {TEAM_PROVIDER_KINDS.map((kind) => {
                    const checked = selected?.allowedTeamProviderKinds.includes(kind) === true;
                    // A kind the deployment cannot run may be removed, never added.
                    const addable = checked || ceilingKinds === null || ceilingKinds.includes(kind);
                    return (
                        <Item
                            key={kind}
                            testID={`home-policy-team-provider:${kind}`}
                            title={teamProviderKindLabel(kind)}
                            loading={pending === kind}
                            disabled={!editable || pending !== null || !addable}
                            onPress={editable && addable ? () => toggleProvider(kind) : undefined}
                            rightElement={(
                                <Switch
                                    testID={`home-policy-team-provider:${kind}-switch`}
                                    value={checked}
                                    disabled={!editable || pending !== null || !addable}
                                    onValueChange={() => toggleProvider(kind)}
                                />
                            )}
                            showChevron={false}
                        />
                    );
                })}
                <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.teamJitAllowed}><Item
                    testID="home-policy-team-jit"
                    title={t('homeGovernance.teamJit')}
                    subtitle={t('homeGovernance.teamJitDescription')}
                    subtitleLines={0}
                    loading={pending === 'jit'}
                    disabled={!editable || pending !== null}
                    onPress={editable ? toggleJit : undefined}
                    rightElement={(
                        <Switch
                            testID="home-policy-team-jit-switch"
                            value={selected?.teamJitAllowed === true}
                            disabled={!editable || pending !== null}
                            onValueChange={toggleJit}
                        />
                    )}
                    showChevron={false}
                /></SettingAnchor>
                <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.approvedGitHubEnterpriseOrigins}><Item
                    title={t('homeGovernance.githubEnterpriseOrigins')}
                    subtitle={t('homeGovernance.githubEnterpriseOriginsDescription')}
                    subtitleLines={0}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="home-policy-team-provider-origins"
                            accessibilityLabel={t('homeGovernance.githubEnterpriseOrigins')}
                            value={originsText}
                            editable={editable && pending === null}
                            multiline
                            autoCapitalize="none"
                            onChangeText={setOriginsDraft}
                            error={originsDraft !== null && !originsValid
                                ? t('homeGovernance.githubEnterpriseOriginsInvalid')
                                : null}
                        />
                    )}
                /></SettingAnchor>
                {editable ? (
                    <SectionContentRow>
                        <SectionButtonRow
                            trailing={(
                                <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.saveOrigins}><RoundButton
                                    testID="home-policy-team-provider-origins-save"
                                    size="small"
                                    title={t('common.save')}
                                    loading={pending === 'origins'}
                                    disabled={pending !== null || originsDraft === null || !originsValid}
                                    onPress={saveOrigins}
                                /></SettingAnchor>
                            )}
                        >
                            {null}
                        </SectionButtonRow>
                    </SectionContentRow>
                ) : null}
                {approvalPending ? (
                    <Item
                        testID="home-policy-team-provider-approval-pending"
                        title={t('connect.waitingForApproval')}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup></SettingAnchor>
        </>
    );
});
