import type { AccountDisplayProfileV1 } from '@happier-dev/protocol';
import {
    HomeAuthenticationPolicyV1Schema,
    TeamCreationPolicyV1Schema,
    type HomeAdministrationEventV1,
    type HomeAuthenticationPolicyV1,
    type HomeGovernancePolicyFieldV1,
} from '@happier-dev/protocol/home/governance';

import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { resolveHomeAccountStatusPresentation } from '@/sync/domains/home/governance/homeAccountAdministration';
import { t } from '@/text';

import { HOME_EMAIL_SETTING_KEYS, homeEmailFieldForKey, type HomeEmailField } from './homeEmailSettingsForm';
import {
    homeAccountModeLabel,
    homeAccountStatusLabel,
    homeAdmissionModeLabel,
    homeRoleLabel,
    homeStoragePolicyLabel,
    teamCreationPolicyLabel,
} from './homeGovernanceLabels';
import { homeServerSettingTitle } from './homeServerSettingLabels';

/**
 * How one administration event reads on the Activity page (lab `hcActivity-A`): "**Actor** did
 * what", the area it touched, and the strict `{field, from, to}` lines its summary carries. A secret
 * reads only `not set → set`; the summary never holds its value, so this never could show one.
 */
export type HomeAuditChangeLine = Readonly<{ label: string; from: string; to: string }>;

export type HomeAuditEventPresentation = Readonly<{
    actor: string;
    /** The Account behind the actor, for its avatar; `null` for a deployment actor. */
    actorAccount: Readonly<{ id: string; avatarUrl: string | null }> | null;
    verb: string;
    area: string;
    changes: readonly HomeAuditChangeLine[];
}>;

const EMAIL_KEY_PREFIX = 'HAPPIER_AUTH_EMAIL_';

function genericValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return t('homeGovernance.activity.valueEmpty');
    if (typeof value === 'boolean') return value ? t('homeGovernance.activity.valueOn') : t('homeGovernance.activity.valueOff');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return t('homeGovernance.activity.valueChanged');
}

const EMAIL_FIELD_LABEL: Readonly<Record<HomeEmailField, () => string>> = {
    host: () => t('homeGovernance.email.server'),
    port: () => t('homeGovernance.email.port'),
    secure: () => t('homeGovernance.email.security'),
    username: () => t('homeGovernance.email.username'),
    password: () => t('homeGovernance.email.password'),
    fromAddress: () => t('homeGovernance.email.fromAddress'),
    fromName: () => t('homeGovernance.email.fromName'),
};

function settingLabel(key: string): string {
    const field = homeEmailFieldForKey(key);
    return field ? EMAIL_FIELD_LABEL[field]() : homeServerSettingTitle(key);
}

function settingValue(key: string, value: unknown): string {
    if (key === HOME_EMAIL_SETTING_KEYS.secure && typeof value === 'boolean') {
        return value ? t('homeGovernance.email.tls') : t('homeGovernance.email.starttls');
    }
    return genericValue(value);
}

function policyFieldLabel(field: HomeGovernancePolicyFieldV1): string {
    switch (field) {
        case 'teamCreationPolicy':
            return t('homeGovernance.teamCreation');
        case 'teamsVisibleToMembers':
            return t('homeGovernance.teamsVisibleToMembers');
        case 'authenticationPolicy':
            return t('homeGovernance.signInTitle');
        case 'teamProviderPolicy':
            return t('homeGovernance.activity.fieldTeamProviders');
        case 'identityNetworkPolicy':
            return t('homeGovernance.privateEndpoints');
    }
}

function policyValue(field: HomeGovernancePolicyFieldV1, value: unknown): string {
    const teamCreation = field === 'teamCreationPolicy' ? TeamCreationPolicyV1Schema.safeParse(value) : null;
    if (teamCreation?.success) return teamCreationPolicyLabel(teamCreation.data);
    return genericValue(value);
}

/**
 * The stored sign-in document as the audit row carries it: `null` leaves every field to the
 * deployment; `undefined` means the row holds something this client cannot read.
 */
function readAuthenticationDocument(value: unknown): HomeAuthenticationPolicyV1 | null | undefined {
    if (value === null || value === undefined) return null;
    const parsed = HomeAuthenticationPolicyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/**
 * A sign-in document change as the fields it changed (plan §3.4 "every save audited"), each read
 * the way the Policies page names it. A field the document leaves to the deployment reads
 * "Server default", the page's own word for it.
 */
function authenticationPolicyLines(
    fromValue: unknown,
    toValue: unknown,
    methodName: (id: string) => string,
): HomeAuditChangeLine[] {
    const before = readAuthenticationDocument(fromValue);
    const after = readAuthenticationDocument(toValue);
    if (before === undefined || after === undefined) {
        return [{ label: t('homeGovernance.signInTitle'), from: genericValue(fromValue), to: genericValue(toValue) }];
    }
    const inherited = t('homeGovernance.signInPolicy.recommendedInherited');
    const read = <V>(value: V | undefined, words: (value: V) => string) => (value === undefined ? inherited : words(value));
    const list = <V>(values: readonly V[], words: (value: V) => string) => values.map(words).join(', ');
    const onOff = (on: boolean) => (on ? t('homeGovernance.activity.valueOn') : t('homeGovernance.activity.valueOff'));
    const fields: ReadonlyArray<readonly [label: string, from: string, to: string]> = [
        [t('homeGovernance.signInMethods'),
            read(before?.enabledMethodIds, (ids) => list(ids, methodName)),
            read(after?.enabledMethodIds, (ids) => list(ids, methodName))],
        [t('homeGovernance.signInPolicy.newAccounts'),
            read(before?.admission, homeAdmissionModeLabel),
            read(after?.admission, homeAdmissionModeLabel)],
        [t('homeGovernance.signInPolicy.anonymousSignup'), read(before?.anonymousSignup, onOff), read(after?.anonymousSignup, onOff)],
        [t('homeGovernance.signInPolicy.storagePolicy'),
            read(before?.storagePolicy, homeStoragePolicyLabel),
            read(after?.storagePolicy, homeStoragePolicyLabel)],
        [t('homeGovernance.accountModes'),
            read(before?.permittedAccountModes, (modes) => list(modes, homeAccountModeLabel)),
            read(after?.permittedAccountModes, (modes) => list(modes, homeAccountModeLabel))],
        [t('homeGovernance.recommendedMode'),
            read(before?.recommendedProvisioningMode, homeAccountModeLabel),
            read(after?.recommendedProvisioningMode, homeAccountModeLabel)],
        [t('homeGovernance.signInPolicy.signInService'),
            onOff(before?.signInService?.mode !== 'disabled'),
            onOff(after?.signInService?.mode !== 'disabled')],
    ];
    return fields.filter(([, from, to]) => from !== to).map(([label, from, to]) => ({ label, from, to }));
}

/** An existing Account named in a sentence; an unnamed one carries its hint so two stay distinct. */
function accountInSentence(profile: AccountDisplayProfileV1, accountId: string, viewerAccountId: string | null): string {
    const person = resolveAccountDisplayName({ profile, accountId, viewerAccountId });
    return person.hint ? `${person.name} (${person.hint})` : person.name;
}

function targetName(event: HomeAdministrationEventV1, viewer: string | null): string {
    const target = event.target;
    return target?.profile ? accountInSentence(target.profile, target.id, viewer) : t('homeGovernance.activity.removedAccount');
}

function actorName(event: HomeAdministrationEventV1, viewer: string | null): string {
    switch (event.actor.kind) {
        case 'deployment_command':
            return t('homeGovernance.activity.deploymentCommand');
        case 'personal_home_bootstrap':
            return t('homeGovernance.activity.personalHomeSetup');
        case 'account':
            return event.actor.profile && event.actor.accountId
                ? accountInSentence(event.actor.profile, event.actor.accountId, viewer)
                : t('homeGovernance.activity.someone');
    }
}

type Described = Omit<HomeAuditEventPresentation, 'actor' | 'actorAccount'>;

/** Names only the Home itself knows, read from its current projection by the page. */
export type HomeAuditNames = Readonly<{ methodName: (id: string) => string }>;

const ID_NAMES: HomeAuditNames = { methodName: (id) => id };

function describe(event: HomeAdministrationEventV1, viewer: string | null, names: HomeAuditNames): Described {
    switch (event.action) {
        case 'home.owner.claim': {
            const area = t('homeGovernance.activity.areaOwnership');
            const selfClaim = event.actor.kind === 'account'
                && (event.target === null || event.target.id === event.actor.accountId);
            if (selfClaim) return { verb: t('homeGovernance.activity.claimed'), area, changes: [] };
            return event.target
                ? { verb: t('homeGovernance.activity.madeOwner', { target: targetName(event, viewer) }), area, changes: [] }
                : { verb: t('homeGovernance.activity.assignedOwner'), area, changes: [] };
        }
        case 'home.policy.set':
            return {
                verb: t('homeGovernance.activity.changedPolicies'),
                area: t('homeGovernance.activity.areaPolicies'),
                changes: event.summary.changes.flatMap((change) => (change.field === 'authenticationPolicy'
                    ? authenticationPolicyLines(change.from, change.to, names.methodName)
                    : [{
                        label: policyFieldLabel(change.field),
                        from: policyValue(change.field, change.from),
                        to: policyValue(change.field, change.to),
                    }])),
            };
        case 'home.settings.set':
        case 'home.settings.discard': {
            const summary = event.summary;
            const email = summary.key.startsWith(EMAIL_KEY_PREFIX);
            const change: HomeAuditChangeLine = summary.secret
                ? {
                    label: settingLabel(summary.key),
                    from: summary.from === 'set' ? t('homeGovernance.activity.secretSet') : t('homeGovernance.activity.secretUnset'),
                    to: summary.to === 'set' ? t('homeGovernance.activity.secretSet') : t('homeGovernance.activity.secretUnset'),
                }
                : {
                    label: settingLabel(summary.key),
                    from: settingValue(summary.key, summary.from),
                    to: settingValue(summary.key, summary.to),
                };
            if (event.action === 'home.settings.discard') {
                return {
                    verb: t('homeSettings.activity.discarded'),
                    area: t('homeGovernance.activity.areaServerSettings'),
                    changes: [change],
                };
            }
            return {
                verb: email ? t('homeGovernance.activity.changedEmailSetting') : t('homeGovernance.activity.changedServerSetting'),
                area: email ? t('homeGovernance.activity.areaEmail') : t('homeGovernance.activity.areaServerSettings'),
                changes: [change],
            };
        }
        case 'account.role.set':
            return {
                verb: t('homeGovernance.activity.changedRole', { target: targetName(event, viewer) }),
                area: t('homeGovernance.activity.areaPeople'),
                changes: [{
                    label: t('homeGovernance.activity.fieldRole'),
                    from: homeRoleLabel(event.summary.from),
                    to: homeRoleLabel(event.summary.to),
                }],
            };
        case 'account.status.set': {
            const target = targetName(event, viewer);
            const from = resolveHomeAccountStatusPresentation(event.summary.from).label;
            const to = resolveHomeAccountStatusPresentation(event.summary.to).label;
            const area = t('homeGovernance.activity.areaPeople');
            if (from === 'active' && to === 'disabled') {
                return { verb: t('homeGovernance.activity.disabled', { target }), area, changes: [] };
            }
            if (from === 'disabled' && to === 'active') {
                return { verb: t('homeGovernance.activity.reenabled', { target }), area, changes: [] };
            }
            return {
                verb: t('homeGovernance.activity.changedStatus', { target }),
                area,
                changes: [{
                    label: t('homeGovernance.activity.fieldStatus'),
                    from: homeAccountStatusLabel(event.summary.from),
                    to: homeAccountStatusLabel(event.summary.to),
                }],
            };
        }
        case 'account.sign_out_everywhere':
            return {
                verb: t('homeGovernance.activity.signedOutEverywhere', { target: targetName(event, viewer) }),
                area: t('homeGovernance.activity.areaPeople'),
                changes: [],
            };
        case 'account.delete':
            return {
                verb: event.summary.outcome === 'deleted'
                    ? t('homeGovernance.activity.deleted', { target: targetName(event, viewer) })
                    : t('homeGovernance.activity.deletionStarted', { target: targetName(event, viewer) }),
                area: t('homeGovernance.activity.areaPeople'),
                changes: [],
            };
        case 'teams.members.remove':
            return {
                verb: event.actor.kind === 'account' && event.actor.accountId === event.target?.id
                    ? t('teams.leave.auditLeft', { team: event.summary.teamName })
                    : t('teams.leave.auditRemoved', { team: event.summary.teamName, target: targetName(event, viewer) }),
                area: t('teams.title'),
                changes: [],
            };
        case 'identity_provider.create':
        case 'identity_provider.update':
        case 'identity_provider.secret.replace':
        case 'identity_provider.enable':
        case 'identity_provider.disable':
        case 'identity_provider.remove':
            return {
                verb: identityProviderVerb(event.action, event.summary.displayName),
                area: t('homeGovernance.signInProviders.title'),
                changes: [],
            };
        case 'github_app.create':
            return { verb: t('homeGovernance.signInProviders.activity.addedGitHubApp', { name: event.summary.name }), area: t('homeGovernance.signInProviders.title'), changes: [] };
        case 'github_app.update':
            return {
                verb: event.summary.secretsReplaced
                    ? t('homeGovernance.signInProviders.activity.replacedGitHubAppSecrets', { name: event.summary.name })
                    : t('homeGovernance.signInProviders.activity.changedGitHubApp', { name: event.summary.name }),
                area: t('homeGovernance.signInProviders.title'),
                changes: [],
            };
        case 'github_app.installation.verify':
            return {
                verb: t('homeGovernance.signInProviders.activity.verifiedGitHubApp', { name: event.summary.name, organization: event.summary.organization }),
                area: t('homeGovernance.signInProviders.title'),
                changes: [],
            };
        case 'github_app.installation.remove':
            return {
                verb: t('homeGovernance.signInProviders.activity.removedGitHubAppInstallation', { name: event.summary.name, organization: event.summary.organization }),
                area: t('homeGovernance.signInProviders.title'),
                changes: [],
            };
    }
}

function identityProviderVerb(action: Extract<HomeAdministrationEventV1['action'], `identity_provider.${string}`>, name: string): string {
    switch (action) {
        case 'identity_provider.create': return t('homeGovernance.signInProviders.activity.addedProvider', { name });
        case 'identity_provider.update': return t('homeGovernance.signInProviders.activity.changedProvider', { name });
        case 'identity_provider.secret.replace': return t('homeGovernance.signInProviders.activity.replacedProviderSecret', { name });
        case 'identity_provider.enable': return t('homeGovernance.signInProviders.activity.enabledProvider', { name });
        case 'identity_provider.disable': return t('homeGovernance.signInProviders.activity.disabledProvider', { name });
        case 'identity_provider.remove': return t('homeGovernance.signInProviders.activity.removedProvider', { name });
    }
}

export function presentHomeAuditEvent(
    event: HomeAdministrationEventV1,
    /** The Account reading the list: named by the one viewer rule ("Your account" when unnamed). */
    viewerAccountId: string | null = null,
    /** Sign-in method names from the Home's projection; ids where the page has none. */
    names: HomeAuditNames = ID_NAMES,
): HomeAuditEventPresentation {
    return {
        actor: actorName(event, viewerAccountId),
        actorAccount: event.actor.kind === 'account' && event.actor.accountId
            ? { id: event.actor.accountId, avatarUrl: event.actor.profile?.avatarUrl ?? null }
            : null,
        ...describe(event, viewerAccountId, names),
    };
}
