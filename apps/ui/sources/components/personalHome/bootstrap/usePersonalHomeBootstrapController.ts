import * as React from 'react';

import { derivePersonalHomeBootstrapSnapshot } from './derivePersonalHomeBootstrapSnapshot';
import { readThisComputerConnectionFromError } from './personalHomeComputerErrors';
import { isPersonalHomeBootstrapRuntimeHost } from '@/utils/platform/personalHomeBootstrapHost';
import type {
    PersonalHomeBootstrapOperation,
    PersonalHomeBootstrapSnapshot,
    PersonalHomeFacts,
} from './personalHomeBootstrapTypes';

/**
 * How an operation was started. A Retry carries the code of the failure it retries, so the operation
 * can resume what that failure left undone (R12: `cli_choice_service_convergence_failed`).
 */
export type PersonalHomeBootstrapOperationContext = Readonly<{
    trigger: 'automatic' | 'retry' | 'manual';
    previousErrorCode?: string;
}>;

export type PersonalHomeBootstrapOperationRunner = (
    facts: PersonalHomeFacts,
    context?: PersonalHomeBootstrapOperationContext,
) => Promise<void>;

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
    execute: (runner: PersonalHomeBootstrapOperationRunner) => Promise<boolean>;
}>;

function checkingSnapshot(): PersonalHomeBootstrapSnapshot {
    return {
        shouldGateShell: true,
        homeReady: false,
        daemonReady: false,
        phase: 'checking',
        daemonState: 'not-started',
        action: 'none',
    };
}

function operationForSnapshot(snapshot: PersonalHomeBootstrapSnapshot): PersonalHomeBootstrapOperation | null {
    switch (snapshot.phase) {
        case 'ensuring-home':
            return 'ensure-home-ready';
        case 'preparing-computer':
            return 'prepare-computer';
        default:
            return null;
    }
}

function errorSnapshot(snapshot: PersonalHomeBootstrapSnapshot, error: Error): PersonalHomeBootstrapSnapshot {
    const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
    if (
        code === 'personal_home_existing_runtime_conflict'
        || code === 'personal_home_credentials_unverified'
    ) {
        return {
            ...snapshot,
            shouldGateShell: true,
            phase: 'blocked',
            action: 'choose-existing-runtime',
            detail: {
                // S18: credentials this app cannot verify (a Home another Happier app on this
                // computer set up) are named as such, not as a generic existing-Home choice.
                code: code === 'personal_home_credentials_unverified' ? 'existing_runtime_credentials' : 'existing_runtime',
                message: error.message,
                retryable: false,
            },
        };
    }
    if (
        code === 'personal_home_existing_runtime_operation_failed'
        || snapshot.action === 'choose-existing-runtime'
    ) {
        return {
            ...snapshot,
            phase: 'blocked',
            action: 'choose-existing-runtime',
            detail: {
                code: 'existing_runtime_operation_failed',
                message: error.message,
                retryable: true,
            },
        };
    }
    const thisComputer = readThisComputerConnectionFromError(error);
    return {
        ...snapshot,
        shouldGateShell: snapshot.homeReady ? false : true,
        phase: 'blocked',
        action: 'retry',
        detail: {
            code: thisComputer ? thisComputer.status : 'bootstrap_operation_failed',
            message: error.message,
            retryable: true,
            ...(thisComputer ? { thisComputer } : {}),
        },
    };
}

/** The Home and sign-in a failed operation was acting on. */
function operationTargetOf(facts: PersonalHomeFacts): string {
    return `${facts.localHomeIdentity ?? ''}:${facts.localHomeAuth}`;
}

export function usePersonalHomeBootstrapController(
    options: PersonalHomeBootstrapControllerOptions,
): PersonalHomeBootstrapController {
    const enabled = options.enabled !== false;
    const [facts, setFacts] = React.useState<PersonalHomeFacts | null>(options.initialFacts ?? null);
    const [error, setError] = React.useState<Error | null>(null);
    const [isChecking, setIsChecking] = React.useState(options.initialFacts == null);
    const [hasAuthoritativeFacts, setHasAuthoritativeFacts] = React.useState(false);
    const [isOperating, setIsOperating] = React.useState(false);
    const [refreshVersion, setRefreshVersion] = React.useState(0);
    const operationKeyRef = React.useRef<string | null>(null);
    const operationInFlightRef = React.useRef(false);
    // An issued operation's failure outlives successful status reads: facts that merely look healthy
    // do not prove the mutation's unfinished work succeeded. A retry or a refresh clears it, and so do
    // facts showing a different Home or sign-in than the one the failed operation was acting on.
    const operationFailureTargetRef = React.useRef<string | null>(null);
    const mountedRef = React.useRef(true);
    const latestReadFactsRef = React.useRef(options.readFacts);
    const factsReadSequenceRef = React.useRef(0);
    latestReadFactsRef.current = options.readFacts;

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = React.useCallback(() => {
        if (operationInFlightRef.current) return;
        operationKeyRef.current = null;
        operationFailureTargetRef.current = null;
        setHasAuthoritativeFacts(false);
        setError(null);
        setRefreshVersion((value) => value + 1);
    }, []);

    React.useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const readSequence = ++factsReadSequenceRef.current;
        setIsChecking(true);
        void latestReadFactsRef.current()
            .then((nextFacts) => {
                if (cancelled || !mountedRef.current || readSequence !== factsReadSequenceRef.current) return;
                setFacts(nextFacts);
                setHasAuthoritativeFacts(true);
                const failureTarget = operationFailureTargetRef.current;
                if (failureTarget === null || failureTarget !== operationTargetOf(nextFacts)) {
                    operationFailureTargetRef.current = null;
                    setError(null);
                }
            })
            .catch((cause: unknown) => {
                if (cancelled || !mountedRef.current || readSequence !== factsReadSequenceRef.current) return;
                const nextError = cause instanceof Error ? cause : new Error(String(cause));
                setError(nextError);
            })
            .finally(() => {
                if (!cancelled && mountedRef.current && readSequence === factsReadSequenceRef.current) setIsChecking(false);
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

    const execute = React.useCallback(async (
        runner: PersonalHomeBootstrapOperationRunner,
        context: PersonalHomeBootstrapOperationContext = { trigger: 'manual' },
    ): Promise<boolean> => {
        if (!enabled || !facts || operationInFlightRef.current) return false;
        const startedFromExistingRuntimeDecision = derivedSnapshot.action === 'choose-existing-runtime';
        operationInFlightRef.current = true;
        operationFailureTargetRef.current = null;
        setIsOperating(true);

        let operationError: Error | null = null;
        try {
            await runner(facts, context);
        } catch (cause: unknown) {
            const nextError = cause instanceof Error ? cause : new Error(String(cause));
            const code = 'code' in nextError && typeof (nextError as { code?: unknown }).code === 'string'
                ? (nextError as { code: string }).code
                : null;
            operationError = startedFromExistingRuntimeDecision
                && code !== 'personal_home_existing_runtime_conflict'
                && code !== 'personal_home_credentials_unverified'
                ? Object.assign(new Error(nextError.message, { cause: nextError }), {
                    code: 'personal_home_existing_runtime_operation_failed',
                })
                : nextError;
        }

        // Facts are the recovery contract. Re-read them after both success and failure so a
        // partially completed operation cannot publish an error over stale readiness state.
        let nextFacts: PersonalHomeFacts | null = null;
        try {
            const readSequence = ++factsReadSequenceRef.current;
            const observedFacts = await latestReadFactsRef.current();
            if (readSequence === factsReadSequenceRef.current) nextFacts = observedFacts;
        } catch (cause: unknown) {
            if (!operationError) {
                operationError = cause instanceof Error ? cause : new Error(String(cause));
            }
        }

        operationInFlightRef.current = false;
        if (!mountedRef.current) return operationError == null;
        if (nextFacts) setFacts(nextFacts);
        operationFailureTargetRef.current = operationError ? operationTargetOf(nextFacts ?? facts) : null;
        setError(operationError);
        setIsOperating(false);
        return operationError == null;
    }, [derivedSnapshot.action, enabled, facts]);

    const retry = React.useCallback(() => {
        if (snapshot.action === 'choose-existing-runtime') return;
        if (snapshot.action === 'retry') {
            // Home verification/profile adoption remains the canonical bootstrap operation even
            // after the live endpoint is usable. Only a durable completed profile makes a
            // post-ready failure a computer/daemon recovery.
            const operation: PersonalHomeBootstrapOperation = snapshot.homeReady
                && facts?.completedPersonalHomeProfile
                ? 'prepare-computer'
                : 'ensure-home-ready';
            const runner = options.operations?.[operation];
            if (runner && facts) {
                const previousErrorCode = readOperationErrorCode(error);
                void execute(runner, previousErrorCode ? { trigger: 'retry', previousErrorCode } : { trigger: 'retry' });
                return;
            }
        }
        refresh();
    }, [error, execute, facts, options.operations, refresh, snapshot.action, snapshot.homeReady]);

    React.useEffect(() => {
        if (!enabled || !facts || !hasAuthoritativeFacts || error || isChecking || isOperating) return;
        const operation = operationForSnapshot(snapshot);
        const runner = operation ? options.operations?.[operation] : undefined;
        if (!operation || !runner) return;
        if (
            operation === 'prepare-computer'
            && (
                facts.localHomeReachability !== 'reachable'
                || !facts.localHomeIdentity
                || facts.localHomeAuth !== 'present'
            )
        ) return;

        // This key is intentionally transient. Facts remain the recovery contract after a restart.
        const operationKey = `${operation}:${facts.relayRuntime?.status ?? ''}:${facts.localHomeIdentity ?? ''}:${facts.localHomeAuth}:${facts.anonymousSignup}:${facts.daemon?.machineId ?? ''}`;
        if (operationKeyRef.current === operationKey) return;
        operationKeyRef.current = operationKey;
        void execute(runner, { trigger: 'automatic' });
    }, [enabled, error, execute, facts, hasAuthoritativeFacts, isChecking, isOperating, options.operations, snapshot]);

    return {
        facts,
        snapshot,
        error,
        isChecking,
        isOperating,
        refresh,
        retry,
        execute,
    };
}

/** Compatibility export for the gate; host eligibility is owned by the canonical runtime predicate. */
export function isPersonalHomeDesktopHost(): boolean {
    return isPersonalHomeBootstrapRuntimeHost();
}

/** The typed code a failed operation carried (a system-task error code), when it has one. */
function readOperationErrorCode(error: unknown): string | null {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    return typeof code === 'string' && code.trim() ? code.trim() : null;
}
