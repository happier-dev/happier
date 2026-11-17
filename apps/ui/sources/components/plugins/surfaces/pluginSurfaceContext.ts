import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import type {
    PluginSurfaceTarget,
    PluginUiPlatform,
    SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useHighContrastPreference } from '@/hooks/ui/useHighContrastPreference';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useScreenReaderEnabled } from '@/hooks/ui/useScreenReaderEnabled';
import {
    fetchAccountEncryptionMode,
    getAccountEncryptionModeCacheRevision,
    readAccountEncryptionModeReadiness,
    subscribeAccountEncryptionModeCacheInvalidation,
    type AccountEncryptionModeReadinessUnavailable,
} from '@/sync/api/account/apiAccountEncryptionMode';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import type { PluginSurfaceTargetKind } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { PluginSurfaceTargetUndeclaredReason } from '@/sync/domains/plugins/ui/scope/resolveResourceScope';

import { usePluginUiTheme } from './pluginUiThemeProjection';
import { readProjectRepositoryIdentityV1, type ProjectScmContextSnapshotV1, type ProjectSurfaceTargetV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useActiveServerAccountScopeLifetime, useSessionProjectScmSummarySnapshot } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { HappyError } from '@/utils/errors/errors';
import { PluginCompanionOpenedFromContext, PluginPageNavigationContext } from '@/components/plugins/pages/pluginPageNavigationContext';

function freezeOwnedContext<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freezeOwnedContext(child);
        Object.freeze(value);
    }
    return value;
}

/**
 * The single owner of the public `SurfaceContext` snapshot (§3.2, UI-D11).
 *
 * Before this module the React Native mount (`PluginSurfaceHost`) and the
 * hosted-web mount (`PluginHostedWebPane`) each built their own snapshot from
 * their own copies of the same five hooks, and both emitted optional
 * `session`/`project`/`browser` bags rather than one exact target. Two builders
 * for one concept is a split-brain; there is now one environment hook, one
 * target resolver and one context factory, and every mount consumes them.
 */
export type PluginSurfaceEnvironment = Readonly<{
    platform: PluginUiPlatform;
    locale: string;
    direction: SurfaceContext['direction'];
    colorScheme: SurfaceContext['colorScheme'];
    contrast: SurfaceContext['contrast'];
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    safeAreaInsets: SurfaceContext['safeAreaInsets'];
    theme: SurfaceContext['theme'];
    columnVisible: boolean;
    pageNavigation?: NonNullable<SurfaceContext['page']>['navigation'];
    /** Present only for a companion opened from its page's own item (`AppScopeRightSidebar`). */
    openedFrom?: SurfaceContext['openedFrom'];
}>;

/**
 * The identity facts a placement owns. A placement supplies what it actually
 * knows; it never decides which arm the public target takes.
 */
export type PluginSurfaceTargetFacts = Readonly<{
    /**
     * The kind the descriptor declared, or `null` when it declared none this host
     * recognizes (see `resolveResourceScope`). `null` is not a target: it fails
     * resolution rather than becoming `app`.
     */
    targetKind: PluginSurfaceTargetKind | null;
    sessionId?: string | null;
    agentId?: string | null;
    snapshot?: ProjectScmContextSnapshotV1 | null;
    session?: Extract<PluginSurfaceTarget, { kind: 'session' }> | null;
    /** Supplied by the canonical admitted Project context, never a checkout-address alias. */
    project?: ProjectSurfaceTargetV1 | null;
    /** The addressed Machine, independently of the plugin's selected execution origin. */
    serverId?: string | null;
    machineId?: string | null;
    homeId?: string | null;
    installationId?: string | null;
    browserTarget?: BrowserViewTargetV1 | null;
}>;

function readId(value: string | null | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readBrowserOrigin(target: BrowserViewTargetV1): string | undefined {
    if (target.kind !== 'externalUrl') return undefined;
    try {
        return new URL(target.url).origin;
    } catch {
        return undefined;
    }
}

export function normalizePluginSurfacePlatform(platform: string | null | undefined): PluginUiPlatform {
    return platform === 'ios' || platform === 'android' || platform === 'desktop' || platform === 'web'
        ? platform
        : 'web';
}

/**
 * Why a surface's target could not be resolved (§3.2 r0.9), rendered through the
 * host's existing unavailable diagnostic. Two distinct failures share the channel:
 * the descriptor declared no target kind this host recognizes
 * (`surface_target_undeclared`, from `resolveResourceScope`), or it declared one
 * whose principal identity the placement could not supply.
 */
export type PluginSurfaceTargetUnavailableReason =
    | PluginSurfaceTargetUndeclaredReason
    | 'session_target_identity_unavailable'
    | 'project_target_identity_unavailable'
    | 'machine_target_identity_unavailable'
    | 'browser_target_identity_unavailable';

/**
 * The outcome of binding a declared target to the identities a placement owns.
 * Resolution either produces the exact public target or fails; it never
 * substitutes a different public target for a failure.
 */
export type PluginSurfaceTargetResolution =
    | Readonly<{ resolved: true; target: PluginSurfaceTarget }>
    | Readonly<{ resolved: false; reason: PluginSurfaceTargetUnavailableReason }>;

function resolvedTarget(target: PluginSurfaceTarget): PluginSurfaceTargetResolution {
    return Object.freeze({ resolved: true as const, target: Object.freeze(target) });
}

function unresolvedTarget(
    reason: PluginSurfaceTargetUnavailableReason,
): PluginSurfaceTargetResolution {
    return Object.freeze({ resolved: false as const, reason });
}

/**
 * Resolve the exact discriminated target (§3.2).
 *
 * Exactness is the rule, and it **fails closed** (§3.2 r0.9): an arm is emitted
 * only when the placement supplied the identity that arm requires, and
 * `{ kind: 'app' }` is emitted only when the declared kind is actually `app`. A
 * session/project/browser placement that cannot name its principal
 * identity fails resolution, so the host can withhold admission instead of
 * telling the plugin it is genuinely mounted on an app surface — the earlier
 * `{ kind: 'app' }` fallback made a broken mount indistinguishable from a real
 * app mount, which is strictly less truthful than the ambiguity it removed.
 *
 * A `null` kind — the descriptor declared no target this host recognizes — fails
 * the same way and for the same reason: it is the one remaining path by which a
 * surface could have presented as `app` without ever saying `app`.
 *
 * `agentId` and browser `origin` stay optional: each is a genuinely absent fact
 * in reachable cases, not a missing principal identity.
 */
export function resolvePluginSurfaceTarget(
    facts: PluginSurfaceTargetFacts,
): PluginSurfaceTargetResolution {
    switch (facts.targetKind) {
        case 'session': {
            const sessionId = readId(facts.sessionId);
            if (!sessionId) return unresolvedTarget('session_target_identity_unavailable');
            if (facts.session && facts.session.sessionId !== sessionId) return unresolvedTarget('session_target_identity_unavailable');
            const agentId = readId(facts.agentId);
            const repository = readProjectRepositoryIdentityV1({ snapshot: facts.snapshot });
            const branch = facts.snapshot?.branch;
            const currentBranch = branch && !branch.detached ? readId(branch.head) : undefined;
            const headOid = readId(branch?.headOid);
            const target = facts.session ?? { kind: 'session' as const, sessionId, ...(agentId ? { agentId } : {}),
                ...(repository ? { repository } : {}), ...(currentBranch ? { branch: currentBranch } : {}), ...(headOid ? { headOid } : {}) };
            const installationId = readId(facts.installationId);
            return resolvedTarget({ ...target, ...(facts.project ? { project: facts.project } : {}), ...(installationId ? { installationId } : {}) });
        }
        case 'project': {
            return facts.project && readId(facts.project.projectKey)
                ? resolvedTarget(readId(facts.installationId) ? { ...facts.project, installationId: readId(facts.installationId) } : facts.project)
                : unresolvedTarget('project_target_identity_unavailable');
        }
        case 'browser': {
            const browserTarget = facts.browserTarget ?? null;
            const targetId = readId(browserTarget?.targetId);
            if (!browserTarget || !targetId) {
                return unresolvedTarget('browser_target_identity_unavailable');
            }
            const origin = readBrowserOrigin(browserTarget);
            return resolvedTarget({ kind: 'browser', targetId, ...(origin ? { origin } : {}) });
        }
        case 'machine': {
            const serverId = readId(facts.serverId);
            const machineId = readId(facts.machineId);
            const homeId = readId(facts.homeId);
            const installationId = readId(facts.installationId);
            return serverId && machineId
                ? resolvedTarget({ kind: 'machine', serverId, machineId,
                    ...(homeId ? { homeId } : {}), ...(installationId ? { installationId } : {}) })
                : unresolvedTarget('machine_target_identity_unavailable');
        }
        case 'services':
            return resolvedTarget({ kind: 'services',
                ...(facts.project ? { project: facts.project } : {}),
                ...(readId(facts.installationId) ? { installationId: readId(facts.installationId) } : {}),
            });
        case 'app':
            return resolvedTarget({ kind: 'app' });
        case null:
        default:
            return unresolvedTarget('surface_target_undeclared');
    }
}

/** Existing admitted SCM subscriptions only; never starts repository observation or loads a body. */
export function usePluginSessionSurfaceTarget(input: Readonly<{
    sessionId: string | null | undefined;
    serverId: string | null | undefined;
    agentId?: string | null;
    authority?: ActiveServerAccountScopeLifetime | null;
    project?: ProjectSurfaceTargetV1 | null;
    installationId?: string | null;
}>): Extract<PluginSurfaceTarget, { kind: 'session' }> | null {
    const active = useActiveServerAccountScopeLifetime();
    const authority = input.authority === undefined ? active : input.authority;
    const current = authority?.isCurrent() === true && Boolean(input.serverId)
        && areServerProfileIdentifiersEquivalent(authority.scope.serverId, input.serverId!);
    const snapshot = useSessionProjectScmSummarySnapshot(current ? input.sessionId ?? null : null, input.serverId);
    const provider = snapshot?.hostingProvider;
    const branch = snapshot?.branch;
    const baseline = React.useRef<Readonly<{ authority: typeof authority; serverId: typeof input.serverId;
        target: Extract<PluginSurfaceTarget, { kind: 'session' }> }> | null>(null);
    return React.useMemo(() => {
        if (!current) { baseline.current = null; return null; }
        const resolved = resolvePluginSurfaceTarget({ targetKind: 'session', sessionId: input.sessionId, agentId: input.agentId, snapshot,
            project: input.project, installationId: input.installationId });
        if (!resolved.resolved || resolved.target.kind !== 'session') return null;
        const previous = baseline.current?.authority === authority && baseline.current.serverId === input.serverId
            && baseline.current.target.sessionId === input.sessionId ? baseline.current.target : null;
        const repository = previous?.repository && sameStrictJsonValue(previous.repository, resolved.target.repository)
            ? previous.repository : resolved.target.repository;
        const target = previous && sameStrictJsonValue(previous, resolved.target) ? previous
            : Object.freeze({ ...resolved.target, ...(repository ? { repository } : {}) });
        baseline.current = { authority, serverId: input.serverId, target };
        return target;
    }, [authority, current, input.sessionId, input.serverId, input.agentId, input.project, input.installationId, provider?.kind, provider?.baseUrl, provider?.nameWithOwner,
        branch?.head, branch?.headOid, branch?.detached]);
}

/**
 * The mount-lifetime equality fact for an exact public target. This is private
 * lifecycle bookkeeping only: it is deliberately not a wire or persistence
 * encoding. JSON arrays keep all discriminants and optional identities
 * unambiguous without making consumers reconstruct target equality locally.
 */
export function getPluginSurfaceTargetAuthorityKey(target: PluginSurfaceTarget): string {
    switch (target.kind) {
        case 'app':
            return JSON.stringify([target.kind]);
        case 'services':
            return JSON.stringify([target.kind, target.project?.projectKey ?? null,
                target.project?.checkout?.serverId ?? null, target.project?.checkout?.machineId ?? null,
                target.project?.checkout?.id ?? null, target.project?.checkout?.rootPath ?? null,
                target.installationId ?? null]);
        case 'session':
            return JSON.stringify([target.kind, target.sessionId, target.agentId ?? null]);
        case 'project':
            // Account/Home and exact-checkout resource authority have their own
            // lifetimes. Enrichment does not replace the logical Project page.
            return JSON.stringify([target.kind, target.projectKey]);
        case 'machine':
            return JSON.stringify([target.kind, target.serverId, target.machineId, target.homeId ?? null, target.installationId ?? null]);
        case 'browser':
            return JSON.stringify([target.kind, target.targetId, target.origin ?? null]);
    }
}

/** Exact checkout changes replace physical content; branch/HEAD facts replace only Resource demand. */
export function getPluginSurfaceTargetMountKey(target: PluginSurfaceTarget): string {
    const checkout = target.kind === 'project' ? target.checkout : target.kind === 'session' ? target.project?.checkout : undefined;
    return JSON.stringify([getPluginSurfaceTargetAuthorityKey(target),
        checkout ? [checkout.serverId, checkout.id, checkout.machineId, checkout.rootPath] : null,
        target.kind === 'session' || target.kind === 'project' ? target.installationId ?? null : null]);
}

/**
 * Read the environmental facts every mounted plugin surface shares. The theme is
 * projected from the app's ACTIVE theme, and the locale is read at render time
 * so a language change moves the snapshot instead of being frozen into the first
 * memo that happened to run.
 */
export function usePluginSurfaceEnvironment(
    platform: string | null | undefined,
): PluginSurfaceEnvironment {
    const { theme, rt } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const screenReaderEnabled = useScreenReaderEnabled();
    const highContrast = useHighContrastPreference();
    const columnVisible = useAppShellColumn().columnVisible;
    const pageNavigation = React.useContext(PluginPageNavigationContext);
    const openedFrom = React.useContext(PluginCompanionOpenedFromContext);
    const locale = usePreferredLanguage();
    const resolvedPlatform = normalizePluginSurfacePlatform(platform);
    const spinnerStyle = useLocalSetting('loadingIndicatorStyle');
    const spinnerSpeed = useLocalSetting('loadingIndicatorSpeed');
    const spinnerPause = useLocalSetting('loadingIndicatorPause');
    const spinner = React.useMemo(() => Object.freeze({
        style: spinnerStyle,
        speed: spinnerSpeed,
        pause: spinnerPause,
    }), [spinnerStyle, spinnerSpeed, spinnerPause]);
    const pluginTheme = usePluginUiTheme(theme, spinner);
    return React.useMemo(() => Object.freeze({
        platform: resolvedPlatform,
        locale,
        direction: rt.rtl ? 'rtl' as const : 'ltr' as const,
        colorScheme: theme.dark ? 'dark' as const : 'light' as const,
        contrast: highContrast ? 'high' as const : 'normal' as const,
        textScale: rt.fontScale,
        reducedMotion,
        screenReaderEnabled,
        safeAreaInsets: Object.freeze({
            top: rt.insets.top,
            right: rt.insets.right,
            bottom: rt.insets.bottom,
            left: rt.insets.left,
        }),
        theme: pluginTheme,
        columnVisible,
        ...(pageNavigation ? { pageNavigation } : {}),
        ...(openedFrom ? { openedFrom } : {}),
    }), [
        columnVisible,
        pageNavigation,
        openedFrom,
        highContrast,
        locale,
        pluginTheme,
        reducedMotion,
        resolvedPlatform,
        rt.fontScale,
        rt.insets.bottom,
        rt.insets.left,
        rt.insets.right,
        rt.insets.top,
        rt.rtl,
        screenReaderEnabled,
        theme.dark,
    ]);
}

/**
 * Compose the public snapshot from the host-stamped public mount fact. The
 * physical mount binding derives destination mounts from the admitted Registry
 * binding; embedded mounts enter through their own normalized producer.
 */
export function createPluginSurfaceContext(input: Readonly<{
    /** The existing physical renderer's instance id, not a descriptor or container identity. */
    mountId?: SurfaceContext['mountId'];
    mount: SurfaceContext['mount'];
    target: PluginSurfaceTarget;
    /** Resolved by the Account-lifetime-bound host admission path. */
    accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
    /** The physical mount's admitted lifetime, never the globally focused Account. */
    accountLifetime?: Pick<ActiveServerAccountScopeLifetime, 'scope' | 'isCurrent'> | null;
    environment: PluginSurfaceEnvironment;
    translations: Readonly<Record<string, string>>;
    /** Exact target-scoped snapshot; an admitted empty `points` array is valid. */
    targetedContributions?: SurfaceContext['targetedContributions'];
    pendingApproval?: SurfaceContext['pendingApproval'];
    machineConnectionPending?: SurfaceContext['machineConnectionPending'];
    machineExecutionReady?: SurfaceContext['machineExecutionReady'];
    requesterExecutionReady?: SurfaceContext['requesterExecutionReady'];
}>): SurfaceContext {
    return freezeOwnedContext({
        ...(input.mountId === undefined ? {} : { mountId: input.mountId }),
        mount: input.mount,
        target: input.target,
        ...(input.accountLifetime?.isCurrent() === true ? { accountScope: input.accountLifetime.scope } : {}),
        ...(input.mount.kind === 'destination' && input.mount.container === 'appPage'
            ? { page: Object.freeze({ columnVisible: input.environment.columnVisible,
                ...(input.environment.pageNavigation ? { navigation: input.environment.pageNavigation } : {}) }) }
            : {}),
        ...(input.environment.openedFrom ? { openedFrom: input.environment.openedFrom } : {}),
        accountEncryptionMode: input.accountEncryptionMode,
        platform: input.environment.platform,
        locale: input.environment.locale,
        direction: input.environment.direction,
        colorScheme: input.environment.colorScheme,
        contrast: input.environment.contrast,
        textScale: input.environment.textScale,
        reducedMotion: input.environment.reducedMotion,
        screenReaderEnabled: input.environment.screenReaderEnabled,
        safeAreaInsets: input.environment.safeAreaInsets,
        theme: input.environment.theme,
        translations: input.translations,
        ...(input.targetedContributions ? { targetedContributions: input.targetedContributions } : {}),
        ...(input.pendingApproval === undefined ? {} : { pendingApproval: input.pendingApproval }),
        ...(input.machineConnectionPending === undefined ? {} : { machineConnectionPending: input.machineConnectionPending }),
        ...(input.machineExecutionReady === undefined ? {} : { machineExecutionReady: input.machineExecutionReady }),
        ...(input.requesterExecutionReady === undefined ? {} : { requesterExecutionReady: input.requesterExecutionReady }),
    });
}

/** A failed read carries `retry`: it runs the same read again now, keeping this state until it answers. */
type AccountEncryptionModeRetry = Readonly<{ retry?: () => void }>;

export type PluginSurfaceAccountEncryptionModeReadiness =
    | Readonly<{ status: 'loading' }>
    | (Readonly<{ status: 'unavailable'; retrying?: false }> & AccountEncryptionModeRetry)
    | (AccountEncryptionModeReadinessUnavailable & AccountEncryptionModeRetry)
    | Readonly<{ status: 'ready'; mode: SurfaceContext['accountEncryptionMode'] }>;

const ACCOUNT_MODE_LOADING = Object.freeze({ status: 'loading' as const });
const ACCOUNT_MODE_UNAVAILABLE = Object.freeze({ status: 'unavailable' as const });

type ResolvedAccountEncryptionMode = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    credentialScopeKey: string | null;
    resolveMode: ((signal: AbortSignal) => Promise<SurfaceContext['accountEncryptionMode']>) | undefined;
    cacheRevision: number;
    result: Exclude<PluginSurfaceAccountEncryptionModeReadiness, { status: 'loading' }>;
}>;

/**
 * Resolve public disclosure through the canonical Account-mode reader while
 * binding disclosure to its captured Account lifetime. This state
 * is not a second cache: invalidation immediately withholds the value, and an
 * exact-Home reader uses its captured transport instead of the focused Home.
 */
export function usePluginSurfaceAccountEncryptionMode(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    credentials?: AuthCredentials | null;
    /** An exact-Home reader uses the same disclosure lifetime, never the focused Home's transport. */
    resolveMode?: (signal: AbortSignal) => Promise<SurfaceContext['accountEncryptionMode']>;
}>): PluginSurfaceAccountEncryptionModeReadiness {
    const serverId = input.accountLifetime?.scope.serverId;
    const subscribe = React.useCallback((listener: () => void) =>
        subscribeAccountEncryptionModeCacheInvalidation(listener, serverId), [serverId]);
    const getRevision = React.useCallback(() => getAccountEncryptionModeCacheRevision(serverId), [serverId]);
    const cacheRevision = React.useSyncExternalStore(
        subscribe,
        getRevision,
        getRevision,
    );
    const requestRevisionRef = React.useRef(0);
    const credentialScopeKey = input.credentials ? resolveAuthCredentialsScopeKey(input.credentials) : null;
    const credentialsRef = React.useRef(input.credentials);
    credentialsRef.current = input.credentials;
    const [resolved, setResolved] = React.useState<ResolvedAccountEncryptionMode | null>(null);
    // A person's Retry restarts the read; the settled state stays until the new attempt answers.
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt(value => value + 1), []);
    // Source execution readiness cannot withdraw the persisted Account mode.
    // This hook owns its request cancellation; the Account owns disclosure.
    const canReadMode = input.accountLifetime?.isCurrent() === true;

    React.useEffect(() => {
        const accountLifetime = input.accountLifetime;
        const credentials = credentialsRef.current;
        const resolveMode = input.resolveMode;
        const requestRevision = requestRevisionRef.current + 1;
        requestRevisionRef.current = requestRevision;
        setResolved((previous) => (
            previous?.accountLifetime === accountLifetime
            && previous.credentialScopeKey === credentialScopeKey
            && previous.resolveMode === resolveMode
            && previous.cacheRevision === cacheRevision
                ? previous
                : null
        ));

        if (
            !accountLifetime
            || !canReadMode
        ) {
            return;
        }

        const readAbort = new AbortController();
        const retirement = accountLifetime.onRetire(() => {
            readAbort.abort();
            requestRevisionRef.current += 1;
            setResolved((previous) => (
                previous?.accountLifetime === accountLifetime ? null : previous
            ));
        });
        // Explicit credential callers retain their bound adapter. Ordinary
        // mounts acquire the same exact-Home Account context used by Actions;
        // ambient Sync focus is not this surface's Account authority.
        const readCapturedMode = async () => {
            const account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, readAbort.signal);
            try {
                if (!accountLifetime.isCurrent() || account.accountId !== accountLifetime.scope.accountId) {
                    throw new HappyError('Account mode scope retired', false);
                }
                return await account.resolveAccountMode(readAbort.signal);
            } finally { account.dispose(); }
        };
        const onUnavailable = (result: AccountEncryptionModeReadinessUnavailable) => {
            if (requestRevisionRef.current === requestRevision && !readAbort.signal.aborted
                && accountLifetime.isCurrent()) {
                setResolved(previous => previous?.accountLifetime === accountLifetime && previous.result.status === 'unavailable'
                    && previous.result.retrying === true && previous.credentialScopeKey === credentialScopeKey
                    && previous.resolveMode === resolveMode && previous.cacheRevision === cacheRevision
                    ? previous
                    : { accountLifetime, credentialScopeKey, resolveMode, cacheRevision, result: { ...result, retry } });
            }
        };
        const modeRead = credentials && !resolveMode
            ? fetchAccountEncryptionMode(credentials, { onUnavailable }).then(({ mode }) => mode)
            : readAccountEncryptionModeReadiness(
                () => resolveMode ? resolveMode(readAbort.signal) : readCapturedMode(),
                () => !readAbort.signal.aborted && accountLifetime.isCurrent()
                    && cacheRevision === getAccountEncryptionModeCacheRevision(accountLifetime.scope.serverId),
                onUnavailable,
            );
        void modeRead.then(
            (mode) => {
                if (
                    requestRevisionRef.current !== requestRevision
                    || !accountLifetime.isCurrent()
                ) {
                    return;
                }
                setResolved({ accountLifetime, credentialScopeKey, resolveMode, cacheRevision, result: { status: 'ready', mode } });
            },
            () => {
                if (
                    requestRevisionRef.current === requestRevision
                    && accountLifetime.isCurrent()
                ) {
                    setResolved({ accountLifetime, credentialScopeKey, resolveMode, cacheRevision, result: {
                        status: 'unavailable',
                        retry,
                    } });
                }
            },
        );
        return () => {
            readAbort.abort();
            requestRevisionRef.current += 1;
            retirement.dispose();
        };
        // Material/Account/transport changes restart acquisition. Reallocating
        // equal credentials change no encryption fact; disclosure checks the
        // captured Account lifetime on render and settlement.
    }, [attempt, cacheRevision, canReadMode, credentialScopeKey, input.accountLifetime, input.resolveMode, retry]);

    if (!canReadMode) return ACCOUNT_MODE_UNAVAILABLE;

    return resolved
        && resolved.accountLifetime === input.accountLifetime
        && resolved.credentialScopeKey === credentialScopeKey
        && resolved.resolveMode === input.resolveMode
        && resolved.cacheRevision === cacheRevision
        && input.accountLifetime?.isCurrent() === true
        ? resolved.result
        : ACCOUNT_MODE_LOADING;
}
