import * as React from 'react';

import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilitiesInvokeRequest } from '@/sync/ops';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

export type CapabilityInstallability =
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'installable' }>
    | Readonly<{ kind: 'not-installable'; code?: string; message?: string }>
    | Readonly<{ kind: 'error'; code?: string; message?: string }>;

const NOT_INSTALLABLE_ERROR_CODES = new Set<string>([
    'install-not-available',
    'unsupported-method',
    'unsupported-platform',
]);

export function useCapabilityInstallability(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: CapabilityId;
    timeoutMs?: number;
}>): CapabilityInstallability {
    const [state, setState] = React.useState<CapabilityInstallability>({ kind: 'unknown' });

    React.useEffect(() => {
        if (!params.machineId) {
            setState({ kind: 'unknown' });
            return;
        }

        let cancelled = false;
        setState({ kind: 'checking' });

        const request: CapabilitiesInvokeRequest = {
            id: params.capabilityId,
            method: 'install',
            params: { dryRun: true, skipIfInstalled: true },
        };

        (async () => {
            const invoke = await machineCapabilitiesInvoke(params.machineId!, request, {
                timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000,
                serverId: params.serverId,
            });
            if (cancelled) return;

            if (!invoke.supported) {
                setState(invoke.reason === 'not-supported' ? { kind: 'not-installable', code: invoke.reason } : { kind: 'error' });
                return;
            }

            if (invoke.response.ok) {
                setState({ kind: 'installable' });
                return;
            }

            const code = invoke.response.error.code;
            if (typeof code === 'string' && NOT_INSTALLABLE_ERROR_CODES.has(code)) {
                setState({ kind: 'not-installable', code, message: invoke.response.error.message });
                return;
            }

            setState({ kind: 'error', code, message: invoke.response.error.message });
        })().catch((e) => {
            if (cancelled) return;
            setState({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' });
        });

        return () => {
            cancelled = true;
        };
    }, [params.machineId, params.capabilityId, params.serverId, params.timeoutMs]);

    return state;
}
