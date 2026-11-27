import * as React from 'react';
import { ScmBackendDescribeResponseSchema, type ScmBackendDescribeResponse } from '@happier-dev/protocol/scm';
import type { ScmGitIdentityResolution } from '@happier-dev/protocol/scm/gitIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';

/** The describe owner resolves identity on open/retarget and Account identity pushes, never status refresh. */
export function useSessionScmGitIdentity(input: Readonly<{
    sessionId: string;
    serverId?: string;
    accountId?: string;
    sessionPath: string | null;
    enabled: boolean;
}>) {
    const { sessionId, serverId, accountId, sessionPath, enabled } = input;
    const identity = useSetting('scmGitIdentity');
    const key = JSON.stringify([serverId, accountId, sessionId, sessionPath]);
    const [observation, setObservation] = React.useState<Readonly<{
        key: string; resolution: ScmGitIdentityResolution | null;
    }> | null>(null);
    const active = React.useRef<string | null>(null);
    const openedRepository = React.useRef<Readonly<{ key: string; identity: typeof identity }> | null>(null);
    const read = React.useCallback(async (afterSave = false) => {
        if (!enabled || !sessionPath) return;
        let resolution: ScmGitIdentityResolution | null = null;
        try {
            const response = ScmBackendDescribeResponseSchema.safeParse(await runSessionScmRpc<ScmBackendDescribeResponse, { cwd: string }>(
                sessionId, RPC_METHODS.SCM_BACKEND_DESCRIBE, { cwd: sessionPath }, serverId, undefined, accountId));
            if (response.success && response.data.success) resolution = response.data.gitIdentityResolution ?? null;
        } catch {
            // A failed optional description leaves the existing commit path available.
        }
        if (active.current === key) setObservation((current) => (
            !afterSave && current?.key === key
                ? current
                : { key, resolution }
        ));
    }, [accountId, enabled, key, serverId, sessionId, sessionPath]);
    React.useEffect(() => {
        active.current = key;
        if (enabled && (openedRepository.current?.key !== key || openedRepository.current.identity !== identity)) {
            const afterSave = openedRepository.current?.key === key;
            openedRepository.current = { key, identity };
            void read(afterSave);
        }
        return () => { active.current = null; };
    }, [enabled, identity, key, read]);
    const requireIdentity = React.useCallback(() => {
        if (active.current === key) setObservation({ key, resolution: { source: 'none', identity: null } });
    }, [key]);
    const refresh = React.useCallback(() => read(true), [read]);
    return { resolution: observation?.key === key ? observation.resolution : null, refresh, requireIdentity };
}
