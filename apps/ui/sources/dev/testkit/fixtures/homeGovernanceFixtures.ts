import { ManagedIdentityProviderV1Schema, type ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import { AccountDisplayProfileV1Schema, type AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type { FeatureDecision} from '@happier-dev/protocol/features/decision';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import {
    HomeGovernanceProjectionV1Schema,
    HomeGovernancePolicyProjectionV1Schema,
    HomeAccountRowV1Schema,
    HomeAccountDetailV1Schema,
    HomeAccountPickerRowV1Schema,
    HomeSettingEntryV1Schema,
    HomeSettingsProjectionV1Schema,
    HomeMailDeliveryReadinessV1Schema,
    HomeReachabilityV1Schema,
    HomeAdministrationEventV1Schema,
    type HomeAccountDetailV1,
    type HomeAccountPickerRowV1,
    type HomeAccountRowV1,
    type HomeAdministrationEventV1,
    type HomeGovernancePolicyProjectionV1,
    type HomeGovernanceProjectionV1,
    type HomeMailDeliveryReadinessV1,
    type HomeReachabilityV1,
    type HomeSettingEntryV1,
    type HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

/**
 * The Home answers the Home Administration suites share.
 *
 * These are the shapes a Home actually returns, so they travel through the same
 * strict schemas the app parses: a contract change fails these suites rather
 * than being absorbed by a per-file literal that drifted.
 */
export function homeGovernanceProjectionFixture(
    overrides?: Partial<HomeGovernanceProjectionV1>,
): HomeGovernanceProjectionV1 {
    return HomeGovernanceProjectionV1Schema.parse({
        viewer: { accountId: 'account-ada', homeRole: 'owner', status: 'active' },
        capabilities: {
            viewAdministration: true,
            manageAccounts: true,
            manageHomeRoles: true,
            manageTeamCreationPolicy: true,
            manageAuthentication: true,
            manageHomeSettings: true,
            eraseAccounts: true,
            createTeam: true,
            manageAllTeams: true,
        },
        policy: {
            revision: 1,
            teamCreationPolicy: 'managed_only',
            teamsVisibleToMembers: true,
            authentication: { status: 'inherited' },
            teamProviders: { status: 'inherited' },
            identityNetwork: { status: 'inherited' },
            sessionDefaults: null,
        },
        setupState: 'owned',
        activeOwnerCount: 2,
        teamsEnabled: true,
        authenticationOptions: {
            methods: [],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
        ...overrides,
    });
}

/**
 * The neutral presentation fields exactly as the strict Account profile schema
 * defines them. A row built any other way is one no Home could ever send.
 */
export function accountDisplayProfileFixture(
    name: string,
    overrides?: Partial<AccountDisplayProfileV1>,
): AccountDisplayProfileV1 {
    return AccountDisplayProfileV1Schema.parse({
        name,
        firstName: name,
        lastName: null,
        username: null,
        avatarUrl: null,
        ...overrides,
    });
}

/** The policy document a Home returns from its one policy mutation. */
export function homeGovernancePolicyProjectionFixture(
    overrides?: Partial<HomeGovernancePolicyProjectionV1>,
): HomeGovernancePolicyProjectionV1 {
    return HomeGovernancePolicyProjectionV1Schema.parse({ ...homeGovernanceProjectionFixture().policy, ...overrides });
}

export function homeAccountRowFixture(
    accountId: string,
    overrides?: Partial<HomeAccountRowV1>,
): HomeAccountRowV1 {
    return HomeAccountRowV1Schema.parse({
        accountId,
        homeRole: 'member',
        status: 'active',
        profile: accountDisplayProfileFixture(accountId),
        createdAt: 1,
        authentication: {
            signInEmail: null,
            usableMethodIds: [],
        },
        mutationCapabilities: {
            setRole: {
                member: { status: 'unavailable', reason: 'unchanged' },
                admin: { status: 'available' },
                owner: { status: 'available' },
            },
            disable: { status: 'available' },
            reenable: { status: 'unavailable', reason: 'target_not_suspended' },
            delete: { status: 'available' },
            signOutEverywhere: { status: 'available' },
        },
        ...overrides,
    });
}

/** One person as `home.accounts.get` answers: the row plus Teams, counts, providers and events. */
export function homeAccountDetailFixture(
    accountId: string,
    overrides?: Partial<HomeAccountDetailV1>,
): HomeAccountDetailV1 {
    const row = homeAccountRowFixture(accountId);
    return HomeAccountDetailV1Schema.parse({
        ...row,
        publicProfile: { managementCapability: { status: 'available' }, restricted: false },
        authentication: { ...row.authentication, linkedProviderIds: [] },
        teams: [],
        machines: { count: 0 },
        apiTokens: { count: 0, lastUsedAt: null },
        recentEvents: [],
        ...overrides,
    });
}

export function homeAccountPickerRowFixture(
    accountId: string,
    firstName: string,
): HomeAccountPickerRowV1 {
    return HomeAccountPickerRowV1Schema.parse({
        accountId,
        profile: accountDisplayProfileFixture(firstName),
        eligible: true,
    });
}

/**
 * One Home setting as `home.settings.get` projects it: an editable live key the Home has not
 * stored, so it reads its registry default. Secrets pass `secretSet` and never a value.
 */
export function homeSettingEntryFixture(
    key: string,
    overrides?: Partial<HomeSettingEntryV1>,
): HomeSettingEntryV1 {
    return HomeSettingEntryV1Schema.parse({
        key,
        value: null,
        source: 'default',
        fixed: false,
        editable: 'home',
        apply: 'live',
        ...overrides,
    });
}

/**
 * The `email` section of a Home's settings, configured and stored by the Home (not the
 * deployment): the shape an owner sees after saving the mail form once.
 */
export function homeEmailSettingEntriesFixture(
    overrides?: Readonly<Record<string, Partial<HomeSettingEntryV1>>>,
): HomeSettingEntryV1[] {
    const stored = (value: unknown): Partial<HomeSettingEntryV1> => ({ value, source: 'home' });
    const base: Record<string, Partial<HomeSettingEntryV1>> = {
        HAPPIER_AUTH_EMAIL_SMTP_HOST: stored('smtp.example.com'),
        HAPPIER_AUTH_EMAIL_SMTP_PORT: stored(465),
        HAPPIER_AUTH_EMAIL_SMTP_SECURE: stored(true),
        HAPPIER_AUTH_EMAIL_SMTP_USERNAME: stored('home@example.com'),
        HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { value: null, source: 'home', secretSet: true },
        HAPPIER_AUTH_EMAIL_FROM_ADDRESS: stored('home@example.com'),
        HAPPIER_AUTH_EMAIL_FROM_NAME: stored('Example Home'),
    };
    return Object.entries(base).map(([key, entry]) => homeSettingEntryFixture(key, { ...entry, ...overrides?.[key] }));
}

export function homeSettingsProjectionFixture(
    overrides?: Partial<HomeSettingsProjectionV1>,
): HomeSettingsProjectionV1 {
    return HomeSettingsProjectionV1Schema.parse({
        revision: 3,
        startedAt: null,
        entries: homeEmailSettingEntriesFixture(),
        ...overrides,
    });
}

export function homeMailDeliveryReadinessFixture(
    overrides?: Partial<HomeMailDeliveryReadinessV1>,
): HomeMailDeliveryReadinessV1 {
    return HomeMailDeliveryReadinessV1Schema.parse({
        transportConfigured: true,
        linkTargetBuildable: true,
        linkOrigin: 'https://app.example.com',
        ready: true,
        passwordUnreadable: false,
        ...overrides,
    });
}

/** How a Personal Home is reached: an address inferred from Tailscale Serve and active direct connections. */
export function homeReachabilityFixture(overrides?: Partial<HomeReachabilityV1>): HomeReachabilityV1 {
    return HomeReachabilityV1Schema.parse({
        publicAddress: { url: 'https://home-mac.tailnet.ts.net', source: 'inferred', inferredFrom: 'tailscale_serve' },
        webApp: { url: 'https://app.example.com', source: 'default' },
        hostAccess: { method: 'tailscale_serve', exposure: 'private', shareUrl: 'https://home-mac.tailnet.ts.net' },
        iroh: {
            availability: 'available',
            mode: 'enabled',
            modeFixed: false,
            state: 'active',
            endpointId: 'a'.repeat(64),
            failureReason: null,
        },
        ...overrides,
    });
}

type HomeAdministrationEventFixtureInput = HomeAdministrationEventV1 extends infer E
    ? E extends HomeAdministrationEventV1
        ? Omit<E, 'at' | 'actor' | 'target'> & Partial<Pick<E, 'at' | 'actor' | 'target'>>
        : never
    : never;

/** One audit event, acted by an Account with a display profile, about nothing in particular. */
export function homeAdministrationEventFixture(event: HomeAdministrationEventFixtureInput): HomeAdministrationEventV1 {
    return HomeAdministrationEventV1Schema.parse({
        at: 1_700_000_000_000,
        actor: { kind: 'account', accountId: 'account-ada', profile: accountDisplayProfileFixture('Ada') },
        target: null,
        ...event,
    });
}

/** The env key the Home's feature family registers for a feature's switch (`HAPPIER_FEATURE_<X>__ENABLED`). */
export function homeFeatureSwitchKey(featureId: FeatureId): string {
    const path = featureId
        .split('.')
        .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
        .join('_');
    return `HAPPIER_FEATURE_${path}__ENABLED`;
}

/** A feature switch as `home.settings.get` projects it: a Home-editable live boolean, on by default. */
export function homeFeatureSwitchEntryFixture(
    featureId: FeatureId,
    overrides?: Partial<HomeSettingEntryV1>,
): HomeSettingEntryV1 {
    return homeSettingEntryFixture(homeFeatureSwitchKey(featureId), {
        value: true,
        declaration: { type: 'boolean', section: 'features', family: featureId.split('.')[0], featureId, default: true },
        ...overrides,
    });
}

/**
 * The Home's decision for one server feature, as the canonical engine answers it: enabled unless the
 * overrides name the state, the blocking axis and code (and, for `dependency`, the typed blocker).
 */
export function featureDecisionFixture(
    featureId: FeatureId,
    overrides?: Partial<FeatureDecision>,
): FeatureDecision {
    return {
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
        ...overrides,
    };
}

/**
 * One retention domain's two keys as the Home's retention family projects them: its mode (keep
 * forever, or its deleting value) and its days, grouped by the domain id.
 */
export function homeRetentionDomainEntriesFixture(params: Readonly<{
    domain: string;
    envName: string;
    group: 'user' | 'system';
    deleteMode?: 'delete_older_than' | 'delete_inactive';
    mode?: Partial<HomeSettingEntryV1>;
    days?: Partial<HomeSettingEntryV1>;
}>): HomeSettingEntryV1[] {
    const family = `retention.${params.group}`;
    const deleteMode = params.deleteMode ?? 'delete_older_than';
    return [
        homeSettingEntryFixture(`HAPPIER_SERVER_RETENTION__${params.envName}__MODE`, {
            value: 'keep_forever',
            declaration: {
                type: 'enum', section: 'data', family, group: params.domain, default: 'keep_forever',
                bounds: { values: ['keep_forever', deleteMode] },
            },
            ...params.mode,
        }),
        homeSettingEntryFixture(`HAPPIER_SERVER_RETENTION__${params.envName}__${deleteMode === 'delete_inactive' ? 'INACTIVITY_DAYS' : 'DAYS'}`, {
            declaration: { type: 'int', section: 'data', family, group: params.domain, bounds: { min: 1 } },
            ...params.days,
        }),
    ];
}

/** The retention family's global switch and dry-run flag, both off by default. */
export function homeRetentionGlobalEntriesFixture(overrides?: Readonly<{
    enabled?: Partial<HomeSettingEntryV1>;
    dryRun?: Partial<HomeSettingEntryV1>;
}>): HomeSettingEntryV1[] {
    const declaration = { type: 'boolean', section: 'data', family: 'retention', default: false } as const;
    return [
        homeSettingEntryFixture('HAPPIER_SERVER_RETENTION__ENABLED', { value: false, declaration, ...overrides?.enabled }),
        homeSettingEntryFixture('HAPPIER_SERVER_RETENTION__DRY_RUN', { value: false, declaration, ...overrides?.dryRun }),
    ];
}

/** A managed provider projected by the Home identity owner, with variant-valid defaults. */
export function managedIdentityProviderFixture(
    overrides?: Partial<ManagedIdentityProviderV1>,
): ManagedIdentityProviderV1 {
    const common = {
        v: 1, owner: { kind: 'home' }, id: 'provider-1',
        displayName: 'Corporate OIDC', enabled: false, firstEnabledAt: null,
        securityRevision: 1, revision: 4, teamConsumers: [], lastSuccessfulTest: null,
        createdByAccountId: 'account-1', createdAt: 1, updatedAt: 1,
    };
    if (overrides?.kind === 'github_app_identity') {
        return ManagedIdentityProviderV1Schema.parse({ ...common, kind: 'github_app_identity',
            config: { v: 1, kind: 'github_app_identity' }, githubAppInstallationId: 'installation-1', ...overrides });
    }
    return ManagedIdentityProviderV1Schema.parse({
        ...common, kind: 'oidc',
        config: {
            v: 1, kind: 'oidc', issuer: 'https://id.example', clientId: 'client-1',
            clientAuthenticationMethod: 'client_secret_post', scopes: 'openid profile email',
            httpTimeoutSeconds: 15,
            claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: null },
        },
        secret: { configured: true, health: 'configured' },
        ...overrides,
    });
}
