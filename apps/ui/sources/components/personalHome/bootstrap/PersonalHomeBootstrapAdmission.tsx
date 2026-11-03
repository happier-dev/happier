import * as React from 'react';
import type { PersonalHomeAdmission } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { PersonalHomeBootstrapRequestContext } from './personalHomeBootstrapRequest';

/** Keep system-task, auth and daemon hooks unconstructed until setup has been admitted. */
export function PersonalHomeBootstrapAdmission(props: Readonly<{
    admission: PersonalHomeAdmission;
    recoverExistingHome?: boolean;
    runtime: React.ComponentType<Readonly<{ children: React.ReactNode; requested: boolean; onSettled: () => void }>>;
    onRequest?: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    const [requested, setRequested] = React.useState(false);
    const settle = React.useCallback(() => setRequested(false), []);
    const request = React.useCallback(() => {
        setRequested(true);
        props.onRequest?.();
    }, [props.onRequest]);
    const Runtime = props.runtime;
    return (
        <PersonalHomeBootstrapRequestContext.Provider value={props.admission === 'off' ? null : request}>
            {props.recoverExistingHome || (props.admission !== 'off' && (props.admission === 'auto' || requested))
                ? <Runtime requested={requested} onSettled={settle}>{props.children}</Runtime>
                : props.children}
        </PersonalHomeBootstrapRequestContext.Provider>
    );
}
