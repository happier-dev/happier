import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    HomeAdmissionModeV1,
    HomeAuthenticationOptionsV1,
    HomeAuthenticationPolicyV1,
} from '@happier-dev/protocol/home/governance';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Modal } from '@/modal';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { setHomeAuthenticationPolicies } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { homeCompanySignInHref, homeSignInPlatformForKeys, homeSignInPlatformHref } from '../signInProviders/homeSignInPlatforms';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { HOME_AUTHENTICATION_SETTINGS } from './homeAuthenticationSettings';
import {
    homeAccountModeLabel,
    homeAdmissionModeLabel,
    homeGovernanceFailureNotice,
    homeStoragePolicyLabel,
    type HomeStoragePolicy,
} from './homeGovernanceLabels';
import { HomeConsequenceNotice } from './HomeConsequenceNotice';
import { homePolicyWideningCopy, type HomePolicyWideningIntent } from './homePolicyWidening';

type AccountMode = 'plain' | 'e2ee';
type StoragePolicy = HomeStoragePolicy;
type AuthenticationMethod = HomeAuthenticationOptionsV1['methods'][number];

const ADMISSION_CHOICES: readonly HomeAdmissionModeV1[] = ['self_service', 'invitation_only', 'closed'];
const STORAGE_CHOICES: readonly StoragePolicy[] = ['required_e2ee', 'optional', 'plaintext_only'];
const ACCOUNT_MODES: readonly AccountMode[] = ['e2ee', 'plain'];
const STORAGE_STRICTNESS: Readonly<Record<StoragePolicy, number>> = { required_e2ee: 0, optional: 1, plaintext_only: 2 };

/**
 * The Home's stored sign-in document as an editable value.
 *
 * `null` means the document leaves that field to the deployment. It is kept
 * apart from what applies right now (the options' effective answers), so a save
 * never persists a deployment or default value as if the owner had chosen it.
 */
type SignInPolicyDraft = Readonly<{
    enabledMethodIds: readonly string[] | null;
    permittedAccountModes: readonly AccountMode[] | null;
    recommendedProvisioningMode: AccountMode | null;
    admission: HomeAdmissionModeV1 | null;
    signInServiceDisabled: boolean;
    anonymousSignup: boolean | null;
    storagePolicy: StoragePolicy | null;
}>;

const INHERITED_DRAFT: SignInPolicyDraft = Object.freeze({
    enabledMethodIds: null,
    permittedAccountModes: null,
    recommendedProvisioningMode: null,
    admission: null,
    signInServiceDisabled: false,
    anonymousSignup: null,
    storagePolicy: null,
});

function draftFromProjection(context: HomeAdministrationContext): SignInPolicyDraft | null {
    const authentication = context.projection.policy.authentication;
    if (authentication.status === 'unreadable') return null;
    if (authentication.status === 'inherited') return INHERITED_DRAFT;
    return {
        enabledMethodIds: authentication.enabledMethodIds,
        permittedAccountModes: authentication.permittedAccountModes,
        recommendedProvisioningMode: authentication.recommendedProvisioningMode,
        admission: authentication.admission,
        signInServiceDisabled: authentication.signInServiceDisabled,
        anonymousSignup: authentication.anonymousSignup ?? null,
        storagePolicy: authentication.storagePolicy ?? null,
    };
}

function documentFromDraft(draft: SignInPolicyDraft): HomeAuthenticationPolicyV1 {
    return {
        v: 1,
        ...(draft.enabledMethodIds ? { enabledMethodIds: [...draft.enabledMethodIds] } : {}),
        ...(draft.permittedAccountModes ? { permittedAccountModes: [...draft.permittedAccountModes] } : {}),
        ...(draft.recommendedProvisioningMode ? { recommendedProvisioningMode: draft.recommendedProvisioningMode } : {}),
        ...(draft.admission ? { admission: draft.admission } : {}),
        ...(draft.anonymousSignup !== null ? { anonymousSignup: draft.anonymousSignup } : {}),
        ...(draft.storagePolicy ? { storagePolicy: draft.storagePolicy } : {}),
        signInService: draft.signInServiceDisabled ? { mode: 'disabled' } : null,
    };
}

/** Whether the Home currently offers a method, read from its own action decisions. */
function methodEffectivelyOn(method: AuthenticationMethod): boolean {
    return method.actions.some((action) => (action.id === 'login' || action.id === 'provision')
        && (action.enabled || (action.reason !== undefined && action.reason !== 'method_not_enabled')));
}

/**
 * A method's switch: a deployment lock or a missing prerequisite answers first,
 * then the stored list, then what the Home offers today.
 */
function methodOn(method: AuthenticationMethod, draft: SignInPolicyDraft): boolean {
    if (method.unavailable) return false;
    if (method.fixedBy) return methodEffectivelyOn(method);
    return draft.enabledMethodIds ? draft.enabledMethodIds.includes(method.id) : methodEffectivelyOn(method);
}

function methodRowsFor(options: HomeAuthenticationOptionsV1, draft: SignInPolicyDraft): readonly AuthenticationMethod[] {
    const offered = new Set(options.methods.map((method) => method.id));
    // A stored method the deployment no longer lists stays visible so it can be removed.
    const retained = (draft.enabledMethodIds ?? [])
        .filter((id) => !offered.has(id))
        .map((id): AuthenticationMethod => ({ id, displayName: id, actions: [] }));
    return [...options.methods, ...retained];
}

function onMethodIds(rows: readonly AuthenticationMethod[], draft: SignInPolicyDraft, offered: ReadonlySet<string>): string[] {
    return rows
        .filter((method) => (offered.has(method.id) ? methodOn(method, draft) : draft.enabledMethodIds?.includes(method.id) === true))
        .map((method) => method.id);
}

function accountModesView(draft: SignInPolicyDraft, options: HomeAuthenticationOptionsV1): readonly AccountMode[] {
    return draft.permittedAccountModes ?? options.permittedAccountModes;
}

function anonymousSignupView(draft: SignInPolicyDraft, options: HomeAuthenticationOptionsV1): boolean {
    if (options.anonymousSignup?.fixedBy) return options.anonymousSignup.enabled;
    return draft.anonymousSignup ?? options.anonymousSignup?.enabled ?? false;
}

function storagePolicyView(draft: SignInPolicyDraft, options: HomeAuthenticationOptionsV1): StoragePolicy | null {
    const storage = options.storagePolicy;
    if (!storage) return draft.storagePolicy;
    if (storage.fixedBy) return storage.running;
    return draft.storagePolicy ?? storage.pending ?? storage.running;
}

/**
 * What the draft widens, for the confirmation's words only. The Home alone
 * decides whether a save widens anything; this just names the outcome it asks
 * about, most consequential first.
 */
function wideningIntentFor(
    before: SignInPolicyDraft,
    after: SignInPolicyDraft,
    options: HomeAuthenticationOptionsV1,
    rows: readonly AuthenticationMethod[],
): HomePolicyWideningIntent {
    if (after.admission === 'self_service' && before.admission !== 'self_service') return { kind: 'admission_anyone' };
    const offered = new Set(options.methods.map((method) => method.id));
    const beforeOn = new Set(onMethodIds(rows, before, offered));
    const turnedOn = rows.find((method) => offered.has(method.id) && methodOn(method, after) && !beforeOn.has(method.id));
    if (turnedOn) return { kind: 'method', methodId: turnedOn.id, methodName: turnedOn.displayName ?? turnedOn.id };
    if (anonymousSignupView(after, options) && !anonymousSignupView(before, options)) return { kind: 'anonymous_signup' };
    const storageBefore = storagePolicyView(before, options);
    const storageAfter = storagePolicyView(after, options);
    const storageWidened = storageBefore !== null && storageAfter !== null
        && STORAGE_STRICTNESS[storageAfter] > STORAGE_STRICTNESS[storageBefore];
    const plainAdded = accountModesView(after, options).includes('plain') && !accountModesView(before, options).includes('plain');
    if (storageWidened || plainAdded) return { kind: 'unencrypted' };
    if (after.admission === 'invitation_only' && before.admission === 'closed') return { kind: 'admission_invited' };
    return { kind: 'other' };
}

function sameDraft(a: SignInPolicyDraft, b: SignInPolicyDraft): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Where the widening card sits: under the row whose change widens, or above Save when no one row does. */
type WideningAnchor = 'admission' | 'anonymous' | 'encryption' | 'form' | `method:${string}`;

function wideningAnchor(intent: HomePolicyWideningIntent): WideningAnchor {
    switch (intent.kind) {
        case 'admission_anyone':
        case 'admission_invited':
            return 'admission';
        case 'method':
            return `method:${intent.methodId}`;
        case 'anonymous_signup':
            return 'anonymous';
        case 'unencrypted':
            return 'encryption';
        case 'other':
            return 'form';
    }
}

type PendingWidening = Readonly<{
    anchor: WideningAnchor;
    copy: ReturnType<typeof homePolicyWideningCopy>;
    resolve: (confirmed: boolean) => void;
}>;

function problemActionsDescription(method: AuthenticationMethod): string | undefined {
    const lines = method.actions
        .filter((action) => !action.enabled && action.reason !== undefined && action.reason !== 'method_not_enabled')
        .map((action) => {
            const label = action.id === 'login' ? t('homeGovernance.authActionLogin')
                : action.id === 'provision' ? t('homeGovernance.authActionProvision')
                    : t('homeGovernance.authActionConnect');
            const reason = action.reason === 'provisioning_not_enabled' ? t('homeGovernance.authReasonProvisioningNotEnabled')
                : action.reason === 'account_mode_unavailable' ? t('homeGovernance.authReasonAccountModeUnavailable')
                    : t('homeGovernance.authReasonEmailDeliveryUnavailable');
            return `${label}: ${reason}`;
        });
    return lines.length > 0 ? lines.join('\n') : undefined;
}

function admissionDescription(admission: HomeAdmissionModeV1 | null): string {
    switch (admission) {
        case 'self_service': return t('homeGovernance.signInPolicy.admissionAnyoneDescription');
        case 'invitation_only': return t('homeGovernance.signInPolicy.admissionInvitationDescription');
        case 'closed': return t('homeGovernance.signInPolicy.admissionNobodyDescription');
        case null: return t('homeGovernance.authInherited');
    }
}

function storagePolicyDescription(policy: StoragePolicy): string {
    switch (policy) {
        case 'required_e2ee': return t('homeGovernance.signInPolicy.storageRequiredDescription');
        case 'optional': return t('homeGovernance.signInPolicy.storageOptionalDescription');
        case 'plaintext_only': return t('homeGovernance.signInPolicy.storagePlaintextDescription');
    }
}

function accountModeTitle(mode: AccountMode): string {
    return mode === 'plain' ? t('homeGovernance.signInPolicy.allowPlain') : t('homeGovernance.signInPolicy.allowE2ee');
}

function homeHost(serverId: string, fallback: string): string {
    const serverUrl = getServerProfileById(serverId)?.serverUrl ?? '';
    try {
        return new URL(serverUrl).host || fallback;
    } catch {
        return fallback;
    }
}

/**
 * Sign-in methods, who can create an account, and encryption, edited as one
 * draft of the Home's sign-in document and saved in one revision-guarded write
 * (plan `2026-09-26-home-owner-console` §3.4, lab `hcPolicies-A`).
 *
 * The Home decides in both directions inside the deployment's locks: a row the
 * deployment fixes is shown read-only with its key, a method the deployment
 * cannot run says what it lacks. Whether a save widens anything is the Home's
 * answer too; when it does, the save asks once (lab `hcPolicies-W`) and resends
 * the same document confirmed. Narrowing saves straight away.
 */
export const SignInPolicyEditor = React.memo(function SignInPolicyEditor(
    props: Readonly<{ context: HomeAdministrationContext }>,
) {
    const { context } = props;
    const router = useRouter();
    const options = context.projection.authenticationOptions;
    const committed = draftFromProjection(context);
    const committedKey = committed ? JSON.stringify(committed) : '';
    const [draft, setDraft] = React.useState<SignInPolicyDraft | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [widening, setWidening] = React.useState<PendingWidening | null>(null);
    const wideningRef = React.useRef<PendingWidening | null>(null);
    const operationInFlightRef = React.useRef<symbol | null>(null);

    /** Settles the owner's answer to the Home's widening question, once. */
    const answerWidening = React.useCallback((confirmed: boolean) => {
        const pending = wideningRef.current;
        wideningRef.current = null;
        setWidening(null);
        pending?.resolve(confirmed);
    }, []);
    const selected = draft ?? committed;
    const editable = context.projection.capabilities.manageAuthentication
        && context.mutationsAvailable
        && committed !== null;

    React.useEffect(() => {
        operationInFlightRef.current = null;
        setDraft(null);
        setSaving(false);
        // A question asked for another Home or Account, or a page that goes away, is a "no".
        return () => answerWidening(false);
    }, [answerWidening, context.scope.serverId, context.scope.accountId]);

    React.useEffect(() => {
        setDraft((current) => (current && JSON.stringify(current) === committedKey ? null : current));
    }, [committedKey]);

    if (!committed || !selected) {
        return (
            <ItemGroup title={t('homeGovernance.signInTitle')} description={t('homeGovernance.authUnreadableDescription')}>
                <Item testID="home-policy-auth-unreadable" title={t('homeGovernance.authUnreadable')} showChevron={false} />
            </ItemGroup>
        );
    }

    const interactive = editable && !saving;
    const offered = new Set(options.methods.map((method) => method.id));
    const methodRows = methodRowsFor(options, selected);
    const onIds = onMethodIds(methodRows, selected, offered);
    const modes = accountModesView(selected, options);
    const dirty = draft !== null && !sameDraft(draft, committed);
    const valid = (selected.enabledMethodIds === null || selected.enabledMethodIds.length > 0)
        && modes.length > 0
        && (selected.recommendedProvisioningMode === null || modes.includes(selected.recommendedProvisioningMode));

    const patch = (values: Partial<SignInPolicyDraft>) => setDraft({ ...selected, ...values });
    const toggleMethod = (method: AuthenticationMethod) => {
        const on = onIds.includes(method.id);
        if (on && onIds.length === 1) return;
        patch({ enabledMethodIds: on ? onIds.filter((id) => id !== method.id) : [...onIds, method.id] });
    };
    const toggleMode = (mode: AccountMode) => {
        const included = modes.includes(mode);
        if (included && modes.length === 1) return;
        patch({ permittedAccountModes: included ? modes.filter((candidate) => candidate !== mode) : [...modes, mode] });
    };

    const save = async () => {
        if (operationInFlightRef.current !== null || !draft || !valid) return;
        const operationIdentity = Symbol('sign-in-policy');
        operationInFlightRef.current = operationIdentity;
        setSaving(true);
        try {
            const intent = wideningIntentFor(committed, draft, options, methodRows);
            const outcome = await setHomeAuthenticationPolicies({
                scope: context.scope,
                expectedRevision: context.projection.policy.revision,
                authenticationPolicy: documentFromDraft(draft),
                // The Home refused it as widening: ask inline, at the row that widens (lab `hcPolicies-W`).
                confirmWidening: () => new Promise<boolean>((resolve) => {
                    const pending: PendingWidening = {
                        anchor: wideningAnchor(intent),
                        copy: homePolicyWideningCopy(intent, homeHost(context.scope.serverId, context.homeName)),
                        resolve,
                    };
                    wideningRef.current = pending;
                    setWidening(pending);
                }),
            });
            if (operationInFlightRef.current !== operationIdentity) return;
            if (outcome.kind === 'succeeded') {
                // The Home was re-read before the answer came back; its document is the truth now.
                setDraft(null);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            // The owner declined the widening: nothing was written and the draft stays theirs.
            if (outcome.failure.code === 'home_policy_widening_unconfirmed') return;
            if (outcome.failure.code === 'home_policy_revision_conflict') {
                await Modal.alertAsync(t('homeGovernance.revisionConflictTitle'), t('homeGovernance.revisionConflictBody'));
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

    const readOnlyDescription = context.mutationsAvailable ? t('homeGovernance.policyReadOnly') : undefined;
    const anonymous = options.anonymousSignup;
    const storage = options.storagePolicy;
    const storageSelected = storagePolicyView(selected, options);
    const storagePendingShown = storage !== undefined && storage.fixedBy === null && storageSelected !== null
        && storageSelected !== storage.running;
    const recommendedTab = selected.recommendedProvisioningMode ?? 'inherited';
    const wideningCard = (anchor: WideningAnchor) => (widening?.anchor === anchor ? (
        <HomeConsequenceNotice
            key={`widening:${anchor}`}
            testID={`home-policy-auth-widening:${anchor.replace(/^method:/, '')}`}
            title={widening.copy.title}
            lines={widening.copy.lines}
            actions={(
                <View style={styles.formActions}>
                    <RoundButton
                        testID="home-policy-auth-widening-cancel"
                        size="small"
                        display="inverted"
                        title={t('common.cancel')}
                        onPress={() => answerWidening(false)}
                    />
                    <RoundButton
                        testID="home-policy-auth-widening-confirm"
                        size="small"
                        title={widening.copy.confirm}
                        onPress={() => answerWidening(true)}
                    />
                </View>
            )}
        />
    ) : null);

    const companyProviderNames = (context.projection.identityServices?.deploymentOidcProviders ?? [])
        .map((provider) => provider.displayName)
        .join(' · ');

    return (
        <>
            <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.enabledMethodIds}><ItemGroup
                title={t('homeGovernance.signInMethods')}
                description={options.methods.length === 0
                    ? t('homeGovernance.policyEditingUnavailable')
                    : editable
                        ? t('homeGovernance.signInPolicy.methodsDescription', { home: context.homeName })
                        : readOnlyDescription}
            >
                {methodRows.map((method) => {
                    const on = onIds.includes(method.id);
                    const retained = !offered.has(method.id);
                    const locked = method.fixedBy !== undefined || method.unavailable !== undefined;
                    const canToggle = interactive && !locked && (!retained || on) && !(on && onIds.length === 1);
                    const missingKeys = method.fixedBy ? [] : method.unavailable?.requires ?? [];
                    // Keys this Home can set itself lead to the row that sets them (DR-03); only keys
                    // the deployment alone provides are named, as chips.
                    const setUp = missingKeys.length > 0 ? homeSignInPlatformForKeys(missingKeys) : null;
                    if (setUp) {
                        return (
                            <React.Fragment key={method.id}>
                            <Item
                                testID={`home-policy-auth-method:${method.id}`}
                                title={method.displayName ?? method.id}
                                subtitle={setUp === 'github'
                                    ? t('homeGovernance.signInPolicy.needsGithubApp')
                                    : t('homeGovernance.signInPolicy.needsWorkos')}
                                subtitleLines={0}
                                detail={t('homeGovernance.signInPolicy.setUp')}
                                onPress={() => router.push(homeSignInPlatformHref(context.scope.serverId, setUp) as never)}
                            />
                            {wideningCard(`method:${method.id}`)}
                            </React.Fragment>
                        );
                    }
                    const subtitle = method.fixedBy || missingKeys.length > 0
                        ? undefined
                        : method.unavailable
                            ? t('homeGovernance.signInPolicy.methodUnavailable')
                            : retained
                                ? t('homeGovernance.policyEditingUnavailable')
                                : on ? problemActionsDescription(method) : undefined;
                    return (
                        <React.Fragment key={method.id}>
                        <Item
                            testID={`home-policy-auth-method:${method.id}`}
                            title={method.displayName ?? method.id}
                            subtitle={subtitle}
                            subtitleAccessory={method.fixedBy
                                ? <HomeDeploymentFixedNote keys={[method.fixedBy]} testID={`home-policy-auth-method:${method.id}`} />
                                : missingKeys.length > 0
                                    ? <HomeDeploymentFixedNote kind="unavailable" keys={missingKeys} testID={`home-policy-auth-method:${method.id}`} />
                                    : undefined}
                            subtitleLines={0}
                            disabled={!canToggle}
                            onPress={canToggle ? () => toggleMethod(method) : undefined}
                            rightElement={(
                                <Switch
                                    testID={`home-policy-auth-method:${method.id}-switch`}
                                    value={on}
                                    disabled={!canToggle}
                                    onValueChange={() => toggleMethod(method)}
                                />
                            )}
                            showChevron={false}
                        />
                        {wideningCard(`method:${method.id}`)}
                        </React.Fragment>
                    );
                })}
                {options.signInService.canDisable || selected.signInServiceDisabled ? (
                    <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.signInServiceDisabled}><Item
                        testID="home-policy-auth-service"
                        title={t('homeGovernance.signInPolicy.signInService')}
                        subtitle={t('homeGovernance.signInPolicy.signInServiceDescription')}
                        disabled={!interactive || !options.signInService.canDisable}
                        onPress={interactive && options.signInService.canDisable
                            ? () => patch({ signInServiceDisabled: !selected.signInServiceDisabled })
                            : undefined}
                        rightElement={(
                            <Switch
                                testID="home-policy-auth-service-switch"
                                value={!selected.signInServiceDisabled}
                                disabled={!interactive || !options.signInService.canDisable}
                                onValueChange={(on) => patch({ signInServiceDisabled: !on })}
                            />
                        )}
                        showChevron={false}
                    /></SettingAnchor>
                ) : null}
                {/* Company sign-in is set up on its own page; here it is one line that leads there
                    (lab `hcPolicies-R`). The names are the providers this Home's projection already
                    carries (the deployment's); the Home's own are listed on that page. */}
                <Item
                    testID="home-policy-auth-company-sign-in"
                    title={t('homeGovernance.signInProviders.companySignIn')}
                    subtitle={companyProviderNames || t('homeGovernance.signInProviders.companySignInDescription')}
                    subtitleLines={0}
                    detail={t('homeGovernance.signInProviders.title')}
                    onPress={() => router.push(homeCompanySignInHref(context.scope.serverId) as never)}
                />
            </ItemGroup></SettingAnchor>

            <ItemGroup
                title={t('homeGovernance.signInPolicy.admissionTitle')}
                description={editable ? undefined : readOnlyDescription}
            >
                <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.admission}><SegmentedChoiceItem<HomeAdmissionModeV1 | 'inherited'>
                    testID="home-policy-auth-admission"
                    testIDPrefix="home-policy-auth-admission"
                    title={t('homeGovernance.signInPolicy.newAccounts')}
                    // An inherited admission matches no segment; the line says what applies.
                    subtitle={admissionDescription(selected.admission)}
                    options={ADMISSION_CHOICES.map((admission) => ({
                        id: admission,
                        label: homeAdmissionModeLabel(admission),
                        description: admissionDescription(admission),
                    }))}
                    value={selected.admission ?? 'inherited'}
                    onChange={(admission) => {
                        if (admission !== 'inherited') patch({ admission });
                    }}
                    disabled={!interactive}
                /></SettingAnchor>
                {wideningCard('admission')}
                {anonymous ? (
                    <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.anonymousSignup}><Item
                        testID="home-policy-auth-anonymous"
                        title={t('homeGovernance.signInPolicy.anonymousSignup')}
                        subtitle={anonymous.fixedBy ? undefined : t('homeGovernance.signInPolicy.anonymousSignupDescription')}
                        subtitleAccessory={anonymous.fixedBy
                            ? <HomeDeploymentFixedNote keys={[anonymous.fixedBy]} testID="home-policy-auth-anonymous" />
                            : undefined}
                        disabled={!interactive || anonymous.fixedBy !== null}
                        onPress={interactive && anonymous.fixedBy === null
                            ? () => patch({ anonymousSignup: !anonymousSignupView(selected, options) })
                            : undefined}
                        rightElement={(
                            <Switch
                                testID="home-policy-auth-anonymous-switch"
                                value={anonymousSignupView(selected, options)}
                                disabled={!interactive || anonymous.fixedBy !== null}
                                onValueChange={(on) => patch({ anonymousSignup: on })}
                            />
                        )}
                        showChevron={false}
                    /></SettingAnchor>
                ) : null}
                {wideningCard('anonymous')}
            </ItemGroup>

            <ItemGroup
                title={t('homeGovernance.signInPolicy.encryptionTitle')}
                description={t('homeGovernance.signInPolicy.encryptionDescription')}
            >
                {storage && storageSelected ? (
                    <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.storagePolicy}><SegmentedChoiceItem<StoragePolicy>
                        testID="home-policy-auth-storage"
                        testIDPrefix="home-policy-auth-storage"
                        title={t('homeGovernance.signInPolicy.storagePolicy')}
                        subtitle={storage.fixedBy
                            ? undefined
                            : storagePendingShown
                                ? t('homeGovernance.signInPolicy.storageAppliesAfterRestart', { running: homeStoragePolicyLabel(storage.running) })
                                : storagePolicyDescription(storageSelected)}
                        subtitleAccessory={storage.fixedBy
                            ? <HomeDeploymentFixedNote keys={[storage.fixedBy]} testID="home-policy-auth-storage" />
                            : undefined}
                        subtitleLines={0}
                        options={STORAGE_CHOICES.map((policy) => ({ id: policy, label: homeStoragePolicyLabel(policy) }))}
                        value={storageSelected}
                        onChange={(storagePolicy) => patch({ storagePolicy })}
                        disabled={!interactive || storage.fixedBy !== null}
                    /></SettingAnchor>
                ) : null}
                {ACCOUNT_MODES.map((mode, index) => {
                    const on = modes.includes(mode);
                    const canToggle = interactive && !(on && modes.length === 1);
                    const row = (
                        <Item
                            key={mode}
                            testID={`home-policy-auth-mode:${mode}`}
                            title={accountModeTitle(mode)}
                            disabled={!canToggle}
                            onPress={canToggle ? () => toggleMode(mode) : undefined}
                            rightElement={(
                                <Switch
                                    testID={`home-policy-auth-mode:${mode}-switch`}
                                    value={on}
                                    disabled={!canToggle}
                                    onValueChange={() => toggleMode(mode)}
                                />
                            )}
                            showChevron={false}
                        />
                    );
                    // The section's search anchor is its first row.
                    return index === 0
                        ? <SettingAnchor key={mode} setting={HOME_AUTHENTICATION_SETTINGS.settings.permittedAccountModes}>{row}</SettingAnchor>
                        : row;
                })}
                <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.recommendedProvisioningMode}><SegmentedChoiceItem<AccountMode | 'inherited'>
                    testID="home-policy-auth-recommended"
                    testIDPrefix="home-policy-auth-recommended"
                    title={t('homeGovernance.recommendedMode')}
                    subtitle={t('homeGovernance.recommendedModeDescription')}
                    subtitleLines={0}
                    options={[
                        { id: 'inherited' as const, label: t('homeGovernance.signInPolicy.recommendedInherited') },
                        ...modes.map((mode) => ({
                            id: mode,
                            label: homeAccountModeLabel(mode),
                        })),
                    ]}
                    value={recommendedTab}
                    onChange={(mode) => patch({ recommendedProvisioningMode: mode === 'inherited' ? null : mode })}
                    disabled={!interactive}
                /></SettingAnchor>
                {wideningCard('encryption')}
            </ItemGroup>

            {editable ? (
                <ItemGroup surface="none">
                    {wideningCard('form')}
                    <SectionContentRow>
                        <View style={styles.formActions}>
                            <RoundButton
                                testID="home-policy-auth-cancel"
                                size="small"
                                display="inverted"
                                title={t('common.cancel')}
                                disabled={!dirty || saving}
                                onPress={() => setDraft(null)}
                            />
                            <SettingAnchor setting={HOME_AUTHENTICATION_SETTINGS.settings.saveAuthentication}><RoundButton
                                testID="home-policy-auth-save"
                                size="small"
                                title={t('common.save')}
                                // Waiting on the owner's answer to the widening card is not a spinner.
                                loading={saving && widening === null}
                                disabled={!dirty || !valid || saving}
                                onPress={() => { void save(); }}
                            /></SettingAnchor>
                        </View>
                    </SectionContentRow>
                    {context.approvalPending ? (
                        <Item testID="home-policy-auth-approval-pending" title={t('connect.waitingForApproval')} showChevron={false} />
                    ) : null}
                </ItemGroup>
            ) : null}
        </>
    );
});

const styles = StyleSheet.create(() => ({
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
}));
