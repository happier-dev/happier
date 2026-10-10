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

export type WelcomeAction =
    | Readonly<{ kind: 'authenticate'; request: WelcomeAuthenticationMethod; labelRole: 'new_here' | 'method' }>
    | Readonly<{ kind: 'scan_or_paste_home' }>
    | Readonly<{ kind: 'choose_home' }>
    | Readonly<{ kind: 'choose_sign_in_service' }>
    | Readonly<{ kind: 'create_personal_home' }>;

export type WelcomeEntryModel = Readonly<{
    heading: 'first_time' | 'returning';
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
        | Readonly<{ kind: 'home' }>
        | Readonly<{ kind: 'team' | 'invitation'; label: string; dominantActionId: string | null }>;
    allowedNavigation: Readonly<{
        changeHome: boolean;
        selectService: boolean;
        scanOrPasteHome: boolean;
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
    // Only one card may carry the generic "new here" invitation. A Home that
    // enables a second provisioning method offers a genuinely different
    // journey, and two identically labelled cards would be unchoosable.
    const [primaryProvision, ...remainingProvision] = homeProvision;
    const primaryServiceProvision = serviceMethods.find((row) => row.action.id === 'provision');

    if (input.userHistory === 'first_time') {
        if (primaryProvision) actions.push(methodAction(primaryProvision, 'new_here'));
        actions.push(...homeDirect.map((row) => methodAction(row)));
        actions.push(...remainingProvision.map((row) => methodAction(row)));
    } else {
        actions.push(...homeDirect.map((row) => methodAction(row)));
    }

    if (input.userHistory === 'returning' && input.allowedNavigation.scanOrPasteHome) {
        actions.push({ kind: 'scan_or_paste_home' });
    }
    actions.push(...serviceMethods.map((row) => methodAction(row, row === primaryServiceProvision && !primaryProvision ? 'new_here' : 'method')));
    if (input.userHistory === 'first_time' && input.allowedNavigation.scanOrPasteHome) {
        actions.push({ kind: 'scan_or_paste_home' });
    }
    if (input.allowedNavigation.changeHome) actions.push({ kind: 'choose_home' });
    if (input.allowedNavigation.selectService && (input.target.kind === 'none' || input.target.kind === 'selected_service')) actions.push({ kind: 'choose_sign_in_service' });
    if (input.allowedNavigation.createPersonalHome) actions.push({ kind: 'create_personal_home' });
    if (input.userHistory === 'returning') {
        if (primaryProvision) actions.push(methodAction(primaryProvision, 'new_here'));
        actions.push(...remainingProvision.map((row) => methodAction(row)));
    }

    const unique = actions.filter((action, index) => (
        actions.findIndex((candidate) => actionIdentity(candidate) === actionIdentity(action)) === index
    ));
    const dominantActionId = input.context.kind === 'home' ? null : input.context.dominantActionId;
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

    return {
        heading: input.userHistory,
        showHomeStatus,
        ...(input.target.kind === 'none'
            ? input.serviceCatalogState.kind === 'ready' ? { targetContext: { label: input.serviceCatalogState.name } } : {}
            : { targetContext: { label: input.target.label } }),
        actions: unique.map((action, index) => ({
            id: actionIdentity(action),
            emphasis: index === 0 ? 'primary' : 'secondary',
            action,
        })),
        ...(notice ? { notice } : {}),
    };
}
