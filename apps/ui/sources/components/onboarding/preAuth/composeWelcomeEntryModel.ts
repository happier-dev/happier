import type { ProjectedAuthenticationCatalog } from '@happier-dev/cli-common/authentication/authMethodCatalog';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import type { AccountDirectoryAuthenticationAction, VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { HomeAuthenticationExecution } from '@/auth/capabilities/authMethodCapabilities';

type CatalogMethod = ProjectedAuthenticationCatalog['methods'][number];
type CatalogAction = CatalogMethod['enabledActions'][number];

export type WelcomeAuthenticationMethod =
    | Readonly<{
        method: CatalogMethod;
        action: CatalogAction;
        execution: HomeAuthenticationExecution;
        authority: Readonly<{ purpose: 'home'; target: HomeTargetInput }>;
        intendedHome: HomeTargetInput | null;
    }>
    | Readonly<{
        method: CatalogMethod;
        action: CatalogAction;
        execution: AccountDirectoryAuthenticationAction['execution'];
        authority: Readonly<{ purpose: 'account_service'; service: VerifiedAccountServiceAuthority }>;
        intendedHome: HomeTargetInput | null;
    }>;

/**
 * `login` is the Login door: "Login — I already use Happier" beside First time here on a first run,
 * "Login — let's get back to it" leading on a returning device. As a method it names the way this
 * device signed in last time (`lastUsed`), or the Home's first way in when that is no longer offered.
 */
export type WelcomeAction =
    | Readonly<{ kind: 'authenticate'; request: WelcomeAuthenticationMethod; labelRole: 'new_here' | 'new_account' | 'method'; emailProvision?: WelcomeAuthenticationMethod }>
    | Readonly<{ kind: 'authenticate'; request: WelcomeAuthenticationMethod; labelRole: 'login'; lastUsed: boolean }>
    | Readonly<{ kind: 'scan_or_paste_home'; labelRole: 'login' | 'method' }>
    | Readonly<{ kind: 'choose_home' }>
    | Readonly<{ kind: 'choose_sign_in_service' }>
    | Readonly<{ kind: 'open_terminal_link' }>
    | Readonly<{ kind: 'use_service_as_home'; name: string; url: string }>
    | Readonly<{ kind: 'create_personal_home' }>;

export type WelcomeEntryModel = Readonly<{
    heading: 'first_time' | 'returning';
    chooseHomeDestination: 'direct' | 'picker';
    showSelfHostingFooter: boolean;
    showWaysHeading: boolean;
    showKeyProvisioningIntro: boolean;
    hasLoginDoor: boolean;
    restore: Readonly<{
        title: 'welcome.welcomeSecondaryButton' | 'welcome.welcomeReturningLoginButton' | 'connect.scanExistingHomeQrTitle' | 'connect.usePairingLinkTitle';
        subtitle: 'welcome.loginSubtitleKeyFirst' | 'welcome.loginSubtitleLinkFirst' | 'welcome.welcomeSecondarySubtitle' | 'connect.pairingLinkRequired';
        icon: 'link' | 'qr-code';
    }>;
    /** Only notices about the effective Home target belong in this entry. */
    showHomeStatus: boolean;
    targetContext?: Readonly<{ label: string }>;
    actions: readonly Readonly<{
        id: string;
        emphasis: 'primary' | 'secondary' | 'tertiary';
        action: WelcomeAction;
    }>[];
    notice?: Readonly<{
        kind: 'service_loading' | 'service_unavailable' | 'service_unsupported' | 'service_methodless';
        serviceName: string | null;
        hasUsableHomeMethods: boolean;
    }>;
}>;

export type ComposeWelcomeEntryModelInput = Readonly<{
    target:
        | Readonly<{ kind: 'none' }>
        | Readonly<{ kind: 'selected_service'; label: string }>
        | Readonly<{ kind: 'explicit_home' | 'selected_home'; home: HomeTargetInput; label: string }>;
    homeMethods: readonly WelcomeAuthenticationMethod[];
    /**
     * Exact identity the Home methods were observed from. Only an equal service
     * identity may be a same-server (`self`) deployment eligible for dedupe.
     */
    observedHomeServerIdentityId?: string;
    /** An admitted Home catalog observed at the exact selected service endpoint, never a fallback Home. */
    observedHomeAtServiceEndpoint?: Readonly<{ home: HomeTargetInput; label: string }>;
    context:
        | Readonly<{ kind: 'home' | 'restore' }>
        | Readonly<{ kind: 'team' | 'invitation'; label: string; dominantActionId: string | null }>;
    allowedNavigation: Readonly<{
        changeHome: boolean;
        selectService: boolean;
        scanOrPasteHome: boolean;
        openTerminalLink?: boolean;
        createPersonalHome: boolean;
    }>;
    serviceCatalogState:
        | Readonly<{ kind: 'not_offered' }>
        | Readonly<{ kind: 'loading'; hintName?: string }>
        | Readonly<{
            kind: 'ready';
            authority: VerifiedAccountServiceAuthority;
            name: string;
            methods: readonly WelcomeAuthenticationMethod[];
        }>
        | Readonly<{ kind: 'unavailable' | 'unsupported' | 'methodless'; hintName?: string }>;
    userHistory: 'first_time' | 'returning';
    placement?: Readonly<{
        hasHome: boolean;
        canConnectDirectly: boolean;
        platform: 'phone' | 'computer';
        canScanQr: boolean;
        canShowQr: boolean;
        serviceHome?: Readonly<{ name: string; url: string }>;
    }>;
    /** Catalog method id of this device's last successful sign-in; absent when nothing is recorded. */
    lastSignInMethodId?: string | null;
}>;

function targetIdentity(target: HomeTargetInput | null): string {
    if (!target) return 'none';
    if (target.kind === 'saved_profile') return `profile:${target.profileRef}`;
    if (target.kind === 'https_url') return `url:${target.url}`;
    return `descriptor:${target.descriptor.homeServerIdentityId}:${target.authority}`;
}

function methodAction(request: WelcomeAuthenticationMethod, labelRole: 'new_here' | 'method' = 'method'): WelcomeAction {
    return { kind: 'authenticate', request, labelRole };
}

function isRecordedMethod(row: WelcomeAuthenticationMethod, methodId: string): boolean {
    if (row.action.id === 'provision') return false;
    return row.method.id === methodId || (row.execution.kind === 'oauth' && row.execution.providerId === methodId);
}

function actionIdentity(action: WelcomeAction): string {
    if (action.kind !== 'authenticate') return action.kind;
    const request = action.request;
    const authority = request.authority.purpose === 'home'
        ? `home:${targetIdentity(request.authority.target)}`
        : `service:${request.authority.service.serverIdentityId}:${request.authority.service.endpointUrl}`;
    return [authority, request.authority.purpose, request.method.id, request.action.id, request.action.mode, targetIdentity(request.intendedHome)].join('|');
}

function executionEquivalent(
    home: WelcomeAuthenticationMethod['execution'],
    service: WelcomeAuthenticationMethod['execution'],
): boolean {
    if (home.kind !== service.kind) return false;
    if (home.kind === 'oauth' && service.kind === 'oauth') {
        return home.providerId === service.providerId && home.mode === service.mode;
    }
    return true;
}

/**
 * Same-server dual-role dedupe: on a `self` deployment the Home and its own
 * sign-in service advertise the same providers. Only an exact identity match
 * plus an equal method/action/mode/execution is a duplicate, and the direct
 * Home row is always the one retained, so a Home recovery-key action is never
 * collapsed into a token-only Directory action.
 */
function withoutProvision(rows: readonly WelcomeAuthenticationMethod[]): readonly WelcomeAuthenticationMethod[] {
    return rows.filter((row) => row.action.id !== 'provision');
}

function withoutSameServerDuplicates(
    input: ComposeWelcomeEntryModelInput,
): readonly WelcomeAuthenticationMethod[] {
    if (input.serviceCatalogState.kind !== 'ready') return [];
    const service = input.serviceCatalogState;
    if (!input.observedHomeServerIdentityId || service.authority.serverIdentityId !== input.observedHomeServerIdentityId) {
        return service.methods;
    }
    return service.methods.filter((row) => !input.homeMethods.some((home) => (
        home.method.id === row.method.id
        && home.action.id === row.action.id
        && home.action.mode === row.action.mode
        && executionEquivalent(home.execution, row.execution)
    )));
}

/** A door someone walks through stays a card; everything else is a quiet way in beneath the doors. */
function emphasisOf(action: WelcomeAction, hasAuthentication: boolean): 'secondary' | 'tertiary' {
    if (action.kind === 'create_personal_home') return 'secondary';
    if ((action.kind === 'authenticate' || action.kind === 'scan_or_paste_home') && action.labelRole !== 'method') return 'secondary';
    if (!hasAuthentication && (action.kind === 'choose_home' || action.kind === 'choose_sign_in_service')) return 'secondary';
    return 'tertiary';
}

export function composeWelcomeEntryModel(input: ComposeWelcomeEntryModelInput): WelcomeEntryModel {
    // A verified Home without account sign-in still offers its own key/recovery
    // methods. Only same-endpoint evidence can resolve a mistaken service entry;
    // an unsupported foreign service must never retarget the focused Home.
    if ((input.target.kind === 'none' || input.target.kind === 'selected_service')
        && input.serviceCatalogState.kind === 'unsupported' && input.observedHomeAtServiceEndpoint) {
        input = { ...input, target: { kind: 'selected_home', ...input.observedHomeAtServiceEndpoint } };
    }
    // A service offer without a chosen Home supersedes the unrelated seeded
    // Home. An explicit service choice does so even on a dual-role endpoint,
    // including while discovery is loading or unavailable.
    const sameServer = input.serviceCatalogState.kind === 'ready'
        && input.observedHomeServerIdentityId !== undefined
        && input.serviceCatalogState.authority.serverIdentityId === input.observedHomeServerIdentityId;
    const showHomeStatus = input.target.kind !== 'selected_service'
        && (input.target.kind !== 'none' || input.serviceCatalogState.kind === 'not_offered' || sameServer);
    if (!showHomeStatus) input = { ...input, homeMethods: [], observedHomeServerIdentityId: undefined };
    const homeProvision = input.homeMethods.filter((row) => row.action.id === 'provision');
    const homeDirect = input.homeMethods.filter((row) => row.action.id !== 'provision');
    const serviceMethods = withoutSameServerDuplicates(input);
    const actions: WelcomeAction[] = [];
    const isRestore = input.context.kind === 'restore';
    const firstTime = input.userHistory === 'first_time';
    const oneTapProvision = firstTime && (input.context.kind === 'home' || isRestore)
        ? homeProvision.find((row) => row.execution.kind === 'generated_key')
        : undefined;
    const primaryProvision = oneTapProvision ?? homeProvision[0];
    const remainingProvision = homeProvision.filter((row) => row !== primaryProvision);
    const newHereService = primaryProvision
        ? undefined
        : serviceMethods.find((row) => row.action.id === 'provision');
    const signInOnService = serviceMethods.filter((row) => row !== newHereService).map((row) => methodAction(row));
    const createPersonalHome: readonly WelcomeAction[] = input.allowedNavigation.createPersonalHome
        ? [{ kind: 'create_personal_home' }]
        : [];
    const changeHome: readonly WelcomeAction[] = input.allowedNavigation.changeHome ? [{ kind: 'choose_home' }] : [];
    const chooseService: readonly WelcomeAction[] = input.allowedNavigation.selectService && (input.target.kind === 'none' || input.target.kind === 'selected_service')
        ? [{ kind: 'choose_sign_in_service' }]
        : [];
    const scanOrPaste: readonly WelcomeAction[] = input.allowedNavigation.scanOrPasteHome ? [{ kind: 'scan_or_paste_home', labelRole: 'method' }] : [];
    // Scanning a QR code or entering a secret key restores an account on the Home, so it is the Login
    // door only where Home methods are on offer. It then carries the Home's key, which is not listed twice.
    const pairingDoor = input.allowedNavigation.scanOrPasteHome && input.homeMethods.length > 0;
    const pairingLogin: WelcomeAction = { kind: 'scan_or_paste_home', labelRole: 'login' };
    const quietDirect = (login: WelcomeAction | undefined) => homeDirect
        .filter((row) => !(login === pairingLogin && row.execution.kind === 'key_entry'))
        .map((row) => methodAction(row));
    const newHere = [
        ...(primaryProvision ? [methodAction(primaryProvision, 'new_here')] : []),
        ...(newHereService ? [methodAction(newHereService, 'new_here')] : []),
    ];

    if (isRestore) {
        const directWays = homeDirect.filter((row) => row.execution.kind !== 'key_entry');
        const provider = (row: WelcomeAuthenticationMethod) => row.execution.kind === 'oauth' ? row.execution.providerId : null;
        const ways = [...directWays, ...remainingProvision.filter((row) =>
            provider(row) !== null && !directWays.some((direct) => provider(direct) === provider(row)))];
        const github = ways.find((row) => provider(row) === 'github');
        if (github) actions.push(methodAction(github));
        const emailLogin = directWays.find((row) => row.execution.kind === 'email_password');
        const emailProvision = homeProvision.find((row) => row.execution.kind === 'email_password');
        if (emailLogin) actions.push({ kind: 'authenticate', request: emailLogin, labelRole: 'method', ...(emailProvision ? { emailProvision } : {}) });
        else if (emailProvision && emailProvision !== primaryProvision) actions.push(methodAction(emailProvision));
        actions.push(...ways.filter((row) => row.execution.kind !== 'email_password' && provider(row) !== 'github').map((row) => methodAction(row)));
        if (!input.allowedNavigation.openTerminalLink && oneTapProvision && pairingDoor && input.target.kind !== 'none') actions.push(...changeHome);
        if (input.allowedNavigation.selectService) actions.push({ kind: 'choose_sign_in_service' });
        if (input.allowedNavigation.openTerminalLink) actions.push({ kind: 'open_terminal_link' });
        if (primaryProvision) actions.push({ kind: 'authenticate', request: primaryProvision, labelRole: 'new_account' });
    } else if (oneTapProvision && pairingDoor) {
        actions.push(methodAction(oneTapProvision, 'new_here'), pairingLogin);
    } else if (firstTime) {
        // Service-backed and sign-in-only Homes need to show their actual ways in.
        actions.push(...newHere, ...createPersonalHome);
        const login = actions.length > 0 && pairingDoor ? pairingLogin : undefined;
        if (login) actions.push(login);
        const signIn = [
            ...quietDirect(login),
            ...remainingProvision.map((row) => methodAction(row)),
            ...signInOnService,
        ];
        actions.push(...signIn);
        // Without anything to sign in to, reaching a Home or a service is the first decision.
        if (actions.length === createPersonalHome.length) actions.push(...changeHome, ...chooseService, ...scanOrPaste);
        else actions.push(...(login ? [] : scanOrPaste), ...changeHome, ...chooseService);
    } else {
        // A returning device leads with Login: the way it signed in last time when the Home still offers
        // it, otherwise the QR or key door, otherwise the Home's own order. Starting fresh follows.
        const signInRows = [...homeDirect, ...withoutProvision(serviceMethods)];
        const record = input.lastSignInMethodId ?? null;
        const recorded = record ? signInRows.find((row) => isRecordedMethod(row, record)) : undefined;
        const serverFirst = signInRows[0];
        const login: WelcomeAction | undefined = recorded
            ? { kind: 'authenticate', request: recorded, labelRole: 'login', lastUsed: true }
            : record === null && pairingDoor
                ? pairingLogin
                : serverFirst
                    ? { kind: 'authenticate', request: serverFirst, labelRole: 'login', lastUsed: false }
                    : pairingDoor ? pairingLogin : undefined;
        if (login) actions.push(login);
        actions.push(...newHere, ...createPersonalHome);
        actions.push(...quietDirect(login));
        actions.push(...remainingProvision.map((row) => methodAction(row)));
        actions.push(...signInOnService);
        actions.push(...(login === pairingLogin ? [] : scanOrPaste), ...changeHome, ...chooseService);
    }

    const unique = actions.filter((action, index) => (
        actions.findIndex((candidate) => actionIdentity(candidate) === actionIdentity(action)) === index
    ));
    const dominantActionId = 'dominantActionId' in input.context ? input.context.dominantActionId : null;
    const { placement } = input;
    const hasHome = placement?.hasHome ?? false;
    const chooseHomeDestination = hasHome ? 'picker' : 'direct';
    const canChooseHome = !placement || hasHome || placement.canConnectDirectly;
    const showKeyProvisioningIntro = unique.some((action) =>
        action.kind === 'authenticate' && action.labelRole === 'new_here' && action.request.execution.kind === 'generated_key');
    const restoreDoorFirst = placement && firstTime
        && input.context.kind === 'home'
        && input.target.kind === 'none'
        && !input.allowedNavigation.createPersonalHome
        && !(hasHome && showKeyProvisioningIntro)
        && input.allowedNavigation.scanOrPasteHome;
    if (!canChooseHome) {
        const chooseHomeIndex = unique.findIndex((action) => action.kind === 'choose_home');
        if (chooseHomeIndex >= 0) unique.splice(chooseHomeIndex, 1);
    }
    if (restoreDoorFirst) {
        const restoreIndex = unique.findIndex((action) => action.kind === 'scan_or_paste_home');
        if (restoreIndex >= 0) unique.splice(restoreIndex, 1);
        unique.unshift(pairingLogin);
        if (placement.serviceHome) unique.push({ kind: 'use_service_as_home', ...placement.serviceHome });
    }
    if (dominantActionId) {
        const dominantIndex = unique.findIndex((action) => actionIdentity(action) === dominantActionId);
        if (dominantIndex > 0) unique.unshift(unique.splice(dominantIndex, 1)[0]!);
    }

    // `choose_sign_in_service` is already an ordinary action row whenever the
    // navigation allows it. The notice also distinguishes an optional service
    // failure from a Home entry dead end so the UI never tells users to abandon
    // working Home methods.
    const noticeKindByCatalogState = {
        loading: 'service_loading',
        unavailable: 'service_unavailable',
        unsupported: 'service_unsupported',
        methodless: 'service_methodless',
    } as const;
    const noticeState = input.serviceCatalogState.kind === 'ready' || input.serviceCatalogState.kind === 'not_offered'
        ? null
        : input.serviceCatalogState;
    const notice = noticeState === null
        ? undefined
        : {
            kind: noticeKindByCatalogState[noticeState.kind],
            serviceName: noticeState.hintName ?? null,
            hasUsableHomeMethods: input.homeMethods.length > 0,
        };

    const hasAuthentication = unique.some((action) => action.kind === 'authenticate');
    const hasLoginDoor = unique.some((action) =>
        (action.kind === 'authenticate' || action.kind === 'scan_or_paste_home') && action.labelRole === 'login');
    const leadWithLink = placement?.platform === 'phone';
    const qrAvailable = leadWithLink && (placement.canScanQr || placement.canShowQr);
    return {
        heading: input.userHistory,
        chooseHomeDestination,
        showSelfHostingFooter: !isRestore && hasHome && input.target.kind === 'none' && input.allowedNavigation.changeHome,
        showWaysHeading: !isRestore && firstTime && !hasLoginDoor,
        showKeyProvisioningIntro,
        hasLoginDoor,
        restore: !unique.some((action) => action.kind === 'scan_or_paste_home' && action.labelRole === 'login') ? {
            title: placement?.canScanQr ? 'connect.scanExistingHomeQrTitle' : 'connect.usePairingLinkTitle',
            subtitle: placement?.canScanQr ? 'welcome.welcomeSecondarySubtitle' : 'connect.pairingLinkRequired',
            icon: placement?.canScanQr ? 'qr-code' : 'link',
        } : {
            title: firstTime ? 'welcome.welcomeSecondaryButton' : 'welcome.welcomeReturningLoginButton',
            subtitle: !leadWithLink
                ? 'welcome.loginSubtitleKeyFirst'
                : qrAvailable ? 'welcome.welcomeSecondarySubtitle' : 'welcome.loginSubtitleLinkFirst',
            icon: 'qr-code',
        },
        showHomeStatus: !isRestore && showHomeStatus,
        ...(input.target.kind === 'none'
            ? input.serviceCatalogState.kind === 'ready' ? { targetContext: { label: input.serviceCatalogState.name } } : {}
            : { targetContext: { label: input.target.label } }),
        actions: unique.map((action, index) => ({
            id: actionIdentity(action),
            emphasis: isRestore ? 'tertiary' : index === 0 ? 'primary' : emphasisOf(action, hasAuthentication),
            action,
        })),
        ...(!isRestore && notice ? { notice } : {}),
    };
}
