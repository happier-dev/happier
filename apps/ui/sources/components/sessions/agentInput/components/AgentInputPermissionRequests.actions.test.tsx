import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from '@/components/tools/shell/permissions/permissionShellTestHelpers';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

let detailLevel = 'title';
const metadata = { ...createSessionFixture().metadata!, flavor: 'claude' };

installPermissionShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSetting: (key: string) => key === 'toolViewDetailLevelDefault' ? detailLevel : undefined,
        });
    },
});

const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');

describe('composer permission request actions', () => {
    it('keeps real decision controls available outside each bounded request body for multiple requests', async () => {
        detailLevel = 'title';
        const screen = await renderScreen(<AgentInputAttentionRequests
            sessionId="s1"
            permissionRequests={[
                { id: 'p1', kind: 'permission', tool: 'Bash', arguments: { command: 'pwd' }, createdAt: null },
                { id: 'p2', kind: 'permission', tool: 'Bash', arguments: { command: 'ls' }, createdAt: null },
            ]}
            permissionLocationsById={new Map()}
            metadata={metadata}
            canApprovePermissions
            maxHeightPx={500}
            onContentSizeChange={() => {}}
            onLayout={() => {}}
            onScroll={() => {}}
        />);

        const bodies = screen.findAllByTestId('permission-prompt-scroll-body');
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
            expect(body.findAll((node) => node.props.testID === 'permission-footer.allow')).toHaveLength(0);
        }
        const actions = screen.findAllByTestId('permission-footer.allow');
        expect(actions).toHaveLength(2);
        expect(actions.every((action) => action.props.disabled !== true)).toBe(true);
    });

    it('renders a medium file-write request through the real preview alongside its decision controls', async () => {
        detailLevel = 'summary';
        const content = Array.from({ length: 19 }, (_, index) => `Permission request line ${index + 1}`).join('\n');
        const screen = await renderScreen(<AgentInputAttentionRequests
            sessionId="s1"
            permissionRequests={[
                { id: 'write1', kind: 'permission', tool: 'Write', arguments: { file_path: '/tmp/example.md', content }, createdAt: null },
            ]}
            permissionLocationsById={new Map()}
            metadata={metadata}
            canApprovePermissions
            maxHeightPx={600}
            onContentSizeChange={() => {}}
            onLayout={() => {}}
            onScroll={() => {}}
        />);
        expect(screen.getTextContent()).toContain('Permission request line 19');
        const body = screen.findByTestId('permission-prompt-scroll-body');
        expect(body!.findAll((node) => node.props.testID === 'permission-footer.allow')).toHaveLength(0);
        expect(screen.findByTestId('permission-footer.allow')).toBeTruthy();
    });
});
