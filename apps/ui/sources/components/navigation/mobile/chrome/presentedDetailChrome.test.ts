import { expect, it } from 'vitest';
import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

it.each(['machine', 'environment', 'workflowEditor', 'workflowRun', 'plugin:issues', 'discussion', 'project', 'session'])(
    'presents the mounted %s catalog through the shared detail slot', pageKind => {
        const mountedDetail = { pageKind, identity: 'current', activeId: 'overview' };
        expect(resolveMobileBottomChromeModel({ isAuthenticated: true, pathname: '/detail/current',
            mobileWorkspaceExperience: 'cockpit', mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
        expect(resolveMobileBottomChromeModel({ isAuthenticated: true, pathname: '/detail/current',
            mobileWorkspaceExperience: 'classic', mountedDetail })).toEqual({ kind: 'hidden' });
    },
);
