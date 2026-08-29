import * as React from 'react';

import { isDesktopHost } from '@/utils/platform/desktopHost';

import { derivePersonalHomeBootstrapSnapshot } from './derivePersonalHomeBootstrapSnapshot';
import type {
    PersonalHomeBootstrapOperation,
    PersonalHomeBootstrapSnapshot,
    PersonalHomeFacts,
} from './personalHomeBootstrapTypes';

export type PersonalHomeBootstrapOperationRunner = (facts: PersonalHomeFacts) => Promise<void>;

export type PersonalHomeBootstrapControllerOptions = Readonly<{
    readFacts: () => Promise<PersonalHomeFacts>;
    operations?: Partial<Record<PersonalHomeBootstrapOperation, PersonalHomeBootstrapOperationRunner>>;
    initialFacts?: PersonalHomeFacts | null;
    enabled?: boolean;
}>;

export type PersonalHomeBootstrapController = Readonly<{
    facts: PersonalHomeFacts | null;
    snapshot: PersonalHomeBootstrapSnapshot;
    error: Error | null;
    isChecking: boolean;
    isOperating: boolean;
    refresh: () => void;
    retry: () => void;
}>;

const EMPTY_ROWS = [
    { id: 'home' as const, status: 'pending' as const },
    { id: 'app' as const, status: 'pending' as const },
    { id: 'computer' as const, status: 'pending' as const },
] as const;

function checkingSnapshot(): PersonalHomeBootstrapSnapshot {
    return {
        shouldGateShell: true,
        homeReady: false,
        daemonReady: false,
        phase: 'checking',
        daemonState: 'not-started',
        rows: EMPTY_ROWS,
        action: 'none',
    };
}

function operationForSnapshot(snapshot: PersonalHomeBootstrapSnapshot): PersonalHomeBootstrapOperation | null {
    switch (snapshot.phase) {
        case 'preparing-home':
            return 'prepare-home';
        case 'connecting-app':
            return 'connect-app';
        case 'closing-signup':
            return 'close-signup';
        case 'preparing-computer':
            return 'prepare-computer';
        default:
            return null;
    }
}

function errorSnapshot(snapshot: PersonalHomeBootstrapSnapshot, error: Error): PersonalHomeBootstrapSnapshot {
    return {
        ...snapshot,
        shouldGateShell: snapshot.homeReady ? false : true,
        phase: 'blocked',
        action: 'retry',
        detail: {
            code: 'bootstrap_operation_failed',
            message: error.message,
            retryable: true,
        },
    };
}

export function usePersonalHomeBootstrapController(
    options: PersonalHomeBootstrapControllerOptions,
): PersonalHomeBootstrapController {
    const enabled = options.enabled !== false;
    const [facts, setFacts] = React.useState<PersonalHomeFacts | null>(options.initialFacts ?? null);
    const [error, setError] = React.useState<Error | null>(null);
    const [isChecking, setIsChecking] = React.useState(options.initialFacts == null);
    const [isOperating, setIsOperating] = React.useState(false);
    const [refreshVersion, setRefreshVersion] = React.useState(0);
    const operationKeyRef = React.useRef<string | null>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = React.useCallback(() => {
        operationKeyRef.current = null;
        setError(null);
        setRefreshVersion((value) => value + 1);
    }, []);

    const retry = React.useCallback(() => {
        refresh();
    }, [refresh]);

    React.useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setIsChecking(true);
        void options.readFacts()
            .then((nextFacts) => {
                if (cancelled || !mountedRef.current) return;
                setFacts(nextFacts);
                setError(null);
            })
            .catch((cause: unknown) => {
                if (cancelled || !mountedRef.current) return;
                const nextError = cause instanceof Error ? cause : new Error(String(cause));
                setError(nextError);
            })
            .finally(() => {
                if (!cancelled && mountedRef.current) setIsChecking(false);
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, options.readFacts, refreshVersion]);

    const derivedSnapshot = React.useMemo(
        () => facts ? derivePersonalHomeBootstrapSnapshot(facts) : checkingSnapshot(),
        [facts],
    );
    const snapshot = error ? errorSnapshot(derivedSnapshot, error) : derivedSnapshot;

    React.useEffect(() => {
        if (!enabled || !facts || error || isChecking || isOperating) return;
        const operation = operationForSnapshot(snapshot);
        const runner = operation ? options.operations?.[operation] : undefined;
        if (!operation || !runner) return;

        // This key is intentionally transient. Facts remain the recovery contract after a restart.
        const operationKey = `${operation}:${facts.relayRuntime?.status ?? ''}:${facts.localHomeIdentity ?? ''}:${facts.localHomeAuth}:${facts.anonymousSignup}:${facts.daemon?.machineId ?? ''}`;
        if (operationKeyRef.current === operationKey) return;
        operationKeyRef.current = operationKey;
        setIsOperating(true);
        void runner(facts)
            .then(() => options.readFacts())
            .then((nextFacts) => {
                if (!mountedRef.current) return;
                setFacts(nextFacts);
                setError(null);
            })
            .catch((cause: unknown) => {
                if (!mountedRef.current) return;
                setError(cause instanceof Error ? cause : new Error(String(cause)));
            })
            .finally(() => {
                if (mountedRef.current) setIsOperating(false);
            });
    }, [enabled, error, facts, isChecking, isOperating, options.operations, options.readFacts, snapshot]);

    return {
        facts,
        snapshot,
        error,
        isChecking,
        isOperating,
        refresh,
        retry,
    };
}

/** The default host predicate is kept here so gate placement can be tested without importing Tauri APIs. */
export function isPersonalHomeDesktopHost(): boolean {
    return isDesktopHost();
}
