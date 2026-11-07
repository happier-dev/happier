import * as React from 'react';

import { matchWorkspaceDestinationRoute } from '@/components/appShell/workspace/workspaceRoutes';
import { useSessionRouteQualification, type SessionRouteQualification } from '@/hooks/session/useSessionRouteQualification';

/**
 * A hosted Session destination opened without a Home qualifies its own tab once its sole Home is known,
 * through its navigation owner (one URL replace, no history entry). Renders nothing.
 */
export function HostedSessionRouteQualification(props: Readonly<{
    params: Readonly<Record<string, string>>;
    pathname: string;
    focused: boolean;
    replace: (href: NonNullable<SessionRouteQualification['qualifiedHref']>) => void;
}>): null {
    const query = React.useMemo(() => {
        const pathParams = matchWorkspaceDestinationRoute(props.pathname)?.params ?? {};
        return Object.fromEntries(Object.entries(props.params).filter(([key]) => key !== 'id' && !Object.hasOwn(pathParams, key)));
    }, [props.pathname, props.params]);
    const { qualifiedHref } = useSessionRouteQualification({
        params: props.params, query, pathname: props.pathname, enabled: props.focused,
    });
    const replace = props.replace;
    React.useEffect(() => {
        if (qualifiedHref) replace(qualifiedHref);
    }, [qualifiedHref, replace]);
    return null;
}
