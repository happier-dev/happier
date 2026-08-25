import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { BrowserViewTargetV1 } from '@happier-dev/protocol';
import type {
    PluginSurfaceTarget,
    PluginUiPlatform,
    SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useHighContrastPreference } from '@/hooks/ui/useHighContrastPreference';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useScreenReaderEnabled } from '@/hooks/ui/useScreenReaderEnabled';
import {
    fetchAccountEncryptionMode,
    getAccountEncryptionModeCacheRevision,
    subscribeAccountEncryptionModeCacheInvalidation,
} from '@/sync/api/account/apiAccountEncryptionMode';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPreferredLanguage } from '@/text';
import type { PluginSurfaceTargetKind } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { PluginSurfaceTargetUndeclaredReason } from '@/sync/domains/plugins/ui/scope/resolveResourceScope';

import { projectPluginUiTheme } from './pluginUiThemeProjection';

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
    projectId?: string | null;
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
            const agentId = readId(facts.agentId);
            return resolvedTarget({ kind: 'session', sessionId, ...(agentId ? { agentId } : {}) });
        }
        case 'project': {
            const projectId = readId(facts.projectId);
            return projectId
                ? resolvedTarget({ kind: 'project', projectId })
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
        case 'services':
            return resolvedTarget({ kind: 'services' });
        case 'app':
            return resolvedTarget({ kind: 'app' });
        case null:
        default:
            return unresolvedTarget('surface_target_undeclared');
    }
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
        case 'services':
            return JSON.stringify([target.kind]);
        case 'session':
            return JSON.stringify([target.kind, target.sessionId, target.agentId ?? null]);
        case 'project':
            return JSON.stringify([target.kind, target.projectId]);
        case 'browser':
            return JSON.stringify([target.kind, target.targetId, target.origin ?? null]);
    }
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
    const locale = getPreferredLanguage();
    const resolvedPlatform = normalizePluginSurfacePlatform(platform);
    const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
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
    }), [
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
    mount: SurfaceContext['mount'];
    target: PluginSurfaceTarget;
    /** Resolved by the Account-lifetime-bound host admission path. */
    accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
    environment: PluginSurfaceEnvironment;
    translations: Readonly<Record<string, string>>;
    /** Exact target-scoped snapshot; an admitted empty `points` array is valid. */
    targetedContributions: SurfaceContext['targetedContributions'];
}>): SurfaceContext {
    return Object.freeze({
        mount: input.mount,
        target: input.target,
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
        targetedContributions: input.targetedContributions,
    });
}

type ResolvedAccountEncryptionMode = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    cacheRevision: number;
    mode: SurfaceContext['accountEncryptionMode'];
}>;

/**
 * Resolve the public disclosure through the incumbent Account-mode cache while
 * keeping request currentness local to this physical surface mount. This state
 * is not a second cache: a change is immediately withheld and only the cache
 * owner supplies the next value.
 */
export function usePluginSurfaceAccountEncryptionMode(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    credentials: AuthCredentials | null | undefined;
    /** Gates disclosure through the incumbent physical mount. */
    isCurrent: () => boolean;
}>): SurfaceContext['accountEncryptionMode'] | null {
    const cacheRevision = React.useSyncExternalStore(
        subscribeAccountEncryptionModeCacheInvalidation,
        getAccountEncryptionModeCacheRevision,
        getAccountEncryptionModeCacheRevision,
    );
    const requestRevisionRef = React.useRef(0);
    const isCurrentRef = React.useRef(input.isCurrent);
    isCurrentRef.current = input.isCurrent;
    const [resolved, setResolved] = React.useState<ResolvedAccountEncryptionMode | null>(null);

    React.useEffect(() => {
        const accountLifetime = input.accountLifetime;
        const credentials = input.credentials;
        const requestRevision = requestRevisionRef.current + 1;
        requestRevisionRef.current = requestRevision;
        setResolved(null);

        if (
            !accountLifetime
            || !credentials
            || !accountLifetime.isCurrent()
            || !isCurrentRef.current()
        ) {
            return;
        }

        const retirement = accountLifetime.onRetire(() => {
            requestRevisionRef.current += 1;
            setResolved((previous) => (
                previous?.accountLifetime === accountLifetime ? null : previous
            ));
        });
        void fetchAccountEncryptionMode(credentials).then(
            ({ mode }) => {
                if (
                    requestRevisionRef.current !== requestRevision
                    || !accountLifetime.isCurrent()
                    || !isCurrentRef.current()
                ) {
                    return;
                }
                setResolved({ accountLifetime, cacheRevision, mode });
            },
            () => {
                if (
                    requestRevisionRef.current === requestRevision
                    && accountLifetime.isCurrent()
                    && isCurrentRef.current()
                ) {
                    setResolved(null);
                }
            },
        );
        return () => {
            requestRevisionRef.current += 1;
            retirement.dispose();
        };
    }, [cacheRevision, input.accountLifetime, input.credentials]);

    return resolved
        && resolved.accountLifetime === input.accountLifetime
        && resolved.cacheRevision === cacheRevision
        && input.accountLifetime?.isCurrent() === true
        && isCurrentRef.current()
        ? resolved.mode
        : null;
}
