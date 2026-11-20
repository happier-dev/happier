import * as React from 'react';
import type { PersonalHomeAdmission } from '@/sync/domains/server/setup/setupSurfacePolicy';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { FirstRunPersonalHomeContext, PersonalHomeBootstrapRequestContext } from './personalHomeBootstrapRequest';

type BootstrapRequest = { kind: 'standard' } | { kind: 'first-run'; profile: ServerProfile | null };

/** Keep system-task, auth and daemon hooks unconstructed until setup has been admitted. */
export function PersonalHomeBootstrapAdmission(props: Readonly<{
    admission: PersonalHomeAdmission;
    recoverExistingHome?: boolean;
    runtime: React.ComponentType<Readonly<{ children: React.ReactNode; requested: boolean; onSettled: (profile?: ServerProfile) => void }>>;
    onRequest?: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    const [activation, setActivation] = React.useState<BootstrapRequest | null>(null);
    const firstRun = activation?.kind === 'first-run' ? activation : null;
    const requested = activation !== null && !firstRun?.profile;
    const settle = React.useCallback((profile?: ServerProfile) => {
        setActivation(current => {
            if (current?.kind !== 'first-run' || !profile) return null;
            return current.profile ? current : { kind: 'first-run', profile };
        });
    }, []);
    const finish = React.useCallback(() => settle(), [settle]);
    const request = React.useCallback((entry?: 'first-run') => {
        setActivation(entry === 'first-run' ? { kind: 'first-run', profile: null } : { kind: 'standard' });
        if (entry !== 'first-run') props.onRequest?.();
    }, [props.onRequest]);
    const Runtime = props.runtime;
    return (
        <PersonalHomeBootstrapRequestContext.Provider value={props.admission === 'off' ? null : request}>
            <FirstRunPersonalHomeContext.Provider value={firstRun ? { profile: firstRun.profile, finish } : null}>
                {props.recoverExistingHome || (props.admission !== 'off' && (props.admission === 'auto' || activation))
                    ? <Runtime requested={requested} onSettled={settle}>{props.children}</Runtime>
                    : props.children}
            </FirstRunPersonalHomeContext.Provider>
        </PersonalHomeBootstrapRequestContext.Provider>
    );
}
