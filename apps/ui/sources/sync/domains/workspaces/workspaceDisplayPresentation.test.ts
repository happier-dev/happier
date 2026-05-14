import { describe, expect, it } from 'vitest';

import { resolveWorkspaceDisplayPresentation } from './workspaceDisplayPresentation';

describe('resolveWorkspaceDisplayPresentation', () => {
    const scope = {
        serverId: 'server_a',
        machineId: 'machine_a',
        rootPath: '/Users/lee/Documents/Development/happier/remote-dev',
    };

    it('uses the workspace basename as the default display title while preserving custom labels', () => {
        expect(resolveWorkspaceDisplayPresentation({
            scope,
            workspaceRefs: [],
            fallbackPathLabel: '~/Documents/Development/happier/remote-dev',
        })).toMatchObject({
            displayTitle: 'remote-dev',
            hasCustomLabel: false,
            subtitleEllipsizeMode: 'tail',
        });

        expect(resolveWorkspaceDisplayPresentation({
            scope,
            workspaceRefs: [{
                id: 'workspace-ref-1',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/Users/lee/Documents/Development/happier/remote-dev',
                label: 'Preview app',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
            fallbackPathLabel: '~/Documents/Development/happier/remote-dev',
        })).toMatchObject({
            displayTitle: 'Preview app',
            hasCustomLabel: true,
            subtitleEllipsizeMode: 'tail',
        });
    });

    it('can keep the formatted full path when requested', () => {
        expect(resolveWorkspaceDisplayPresentation({
            scope,
            workspaceRefs: [],
            fallbackPathLabel: '~/Documents/Development/happier/remote-dev',
            fallbackPathDisplayMode: 'path',
        })).toMatchObject({
            displayTitle: '~/Documents/Development/happier/remote-dev',
            hasCustomLabel: false,
            subtitleEllipsizeMode: 'head',
        });
    });
});
