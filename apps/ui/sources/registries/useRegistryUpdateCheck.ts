import * as React from 'react';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryUpdateCheckResultV1, type RegistryKindV1 } from '@happier-dev/protocol/registries';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { useRegistryActionRead } from './useRegistryActionRead';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';

export type RegistryUpdateCheckState = Readonly<{
    checking: boolean;
    /** Last complete check; an unchecked item cannot advance this freshness fact. */
    checkedAt: number | null;
    /** Timestamp carried by the latest finite reply, including partial coverage. */
    attemptedAt?: number | null;
    failed: boolean;
    code: string | null;
    /** Latest attempt, including the per-item source failures the tracker deliberately does not persist. */
    results: RegistryUpdateCheckResultV1['results'];
    /** Native versions held when this attempt began; newer native facts supersede its overlay. */
    basis?: ReadonlyMap<string, string>;
}>;
const EMPTY_CHECK: RegistryUpdateCheckState = Object.freeze({ checking: false, checkedAt: null, failed: false, code: null, results: [] });

/** Transient user-requested checks, shared by Updates and the item detail; no schedule or durable failure state. */
export function useRegistryUpdateCheck(input: Readonly<{
    scopeKey: string;
    execute: MountedAuthoringActionExecute;
    isCurrent: () => boolean;
    kind?: RegistryKindV1;
    keys?: readonly string[];
    retry: () => void;
    enabled?: boolean;
    captureBasis?: () => ReadonlyMap<string, string>;
}>) {
    const { scopeKey, execute, isCurrent, kind, retry } = input;
    const keysKey = JSON.stringify(input.keys ?? null);
    const requestKey = JSON.stringify([scopeKey, kind ?? null, keysKey]);
    const enabled = input.enabled !== false;
    const [state, setState] = React.useState(() => ({ key: requestKey, check: EMPTY_CHECK }));
    const latest = React.useRef({ requestKey, enabled, isCurrent, captureBasis: input.captureBasis });
    latest.current = { requestKey, enabled, isCurrent, captureBasis: input.captureBasis };
    const checkNow = React.useCallback(async () => {
        const current = () => latest.current.requestKey === requestKey && latest.current.enabled && latest.current.isCurrent();
        if (!current()) return;
        const basis = latest.current.captureBasis?.();
        setState(previous => ({ key: requestKey, check: { ...(previous.key === requestKey ? previous.check : EMPTY_CHECK), checking: true } }));
        try {
            const keys: string[] | null = JSON.parse(keysKey);
            const result = await execute('registries.updates.check', { ...(kind ? { kind } : {}), ...(keys ? { keys } : {}) });
            if (!current()) return;
            const parsed = result.ok ? REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].safeParse(result.result) : null;
            setState(previous => {
                const before = previous.key === requestKey ? previous.check : EMPTY_CHECK;
                if (!parsed?.success) return { key: requestKey, check: { ...before, checking: false, failed: true,
                    code: result.ok ? 'invalid_action_output' : result.errorCode ?? result.error } };
                const failures = parsed.data.results.flatMap(item => item.upstream.state === 'unchecked' ? [item.upstream.reason.state] : []);
                return { key: requestKey, check: { checking: false,
                    attemptedAt: parsed.data.checkedAt,
                    checkedAt: failures.length ? before.checkedAt : parsed.data.checkedAt,
                    failed: failures.length > 0, code: failures.length ? [...new Set(failures)].join(',') : null,
                    results: parsed.data.results, ...(basis ? { basis } : {}) } };
            });
            retry();
        } catch (error) {
            if (current()) setState(previous => ({ key: requestKey, check: { ...(previous.key === requestKey ? previous.check : EMPTY_CHECK),
                checking: false, failed: true, code: error instanceof Error ? error.message : 'unknown' } }));
        }
    }, [requestKey, execute, kind, keysKey, retry]);
    return { check: enabled && isCurrent() && state.key === requestKey ? state.check : EMPTY_CHECK, checkNow };
}

/** The open Environment supplies its exact finite demand; the registry owner owns the observation. */
export function useRegistryAppUpdate(detail: DeploymentEnvironmentDetailV1 | null, enabled: boolean) {
    const environment = detail?.environment;
    const active = enabled && Boolean(environment?.capabilities.read && detail?.content.template);
    const sourceRevision = useRegistrySourceRevision(active);
    const input = React.useMemo(() => ({ kind: 'app' as const, environments: environment
        ? [{ environmentId: environment.id, expectedRevision: environment.revision }] : [] }), [environment?.id, environment?.revision]);
    const read = useRegistryActionRead('registries.updates.check', input,
        value => value, sourceRevision, active);
    return { upstream: active && !read.stale && read.error === null
        ? read.value?.results.find(result => result.key === environment?.id)?.upstream ?? null : null,
        loading: read.loading, error: read.error, status: read.status, refresh: read.refresh };
}
