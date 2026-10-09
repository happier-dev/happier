import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPromptStacksCommonModuleMocks } from '@/components/settings/prompts/stacks/promptStacksScreenTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Storage, the Project rows domain and the Context model stay real; only platform boundaries are mocked.
installPromptStacksCommonModuleMocks({ storage: importOriginal => importOriginal() });

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));
vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { ProjectContextBody } = await import('./ProjectContextBody');
const baseline = storage.getState();

const scope = { serverId: 'project-context-home', accountId: 'project-context-account' };
const workspaceRef = { id: 'wr_1', serverId: scope.serverId, machineId: 'm1', rootPath: '/repo/happier', projectKey: 'happier', createdAtMs: 1 };
const entry = (id: string, artifactId: string) => ({ id, ref: { kind: 'doc' as const, artifactId }, enabled: true, placement: 'system_append' as const });
const artifact = (id: string, kind: string, title: string) => ({ id, title, headerVersion: 1, bodyVersion: 1, ownerAccountId: scope.accountId,
    access: 'owner' as const, header: { kind, title }, body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true as const });

describe('ProjectContextBody', () => {
    beforeEach(() => {
        storage.setState(baseline, true);
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope, isDataReady: true });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://project-context.invalid', generation: 1 });
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspaceRef], relationships: [],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'happier' }, revision: 3,
                value: { promptStack: [entry('memory-entry', 'memory-1'), entry('guide-entry', 'guide-1'), entry('gone-entry', 'gone-1')] } }],
            revisionsByPhysicalKey: {} });
        storage.getState().applyArtifacts([artifact('memory-1', 'memory_doc.v1', 'Project memory'), artifact('guide-1', 'prompt_doc.v2', 'API style guide')]);
    });

    it('offers remember before the Project has a memory document', async () => {
        storage.getState().applyArtifacts([artifact('guide-1', 'prompt_doc.v2', 'API style guide')]);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspaceRef], relationships: [],
            organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'happier' }, revision: 4,
                value: { promptStack: [entry('guide-entry', 'guide-1')] } }], revisionsByPhysicalKey: {} });
        const screen = await renderScreen(<ProjectContextBody workspaceRef={workspaceRef} />);
        expect(screen.findByTestId('project-context.memory.remember')).toBeTruthy();
        await screen.pressByTestIdAsync('project-context.memory.remember');
        expect(screen.findByTestId('project-context.memory.draft')).toBeTruthy();
    });

    it('draws the personal Project layer: memory in its own section, documents as rows, an unreadable one without its title', async () => {
        const screen = await renderScreen(<ProjectContextBody workspaceRef={workspaceRef} />);
        const rowTitle = (testID: string) => screen.findAllByTestId(testID).map((node) => node.props.title).find((title) => typeof title === 'string');

        // A Project with no Source has one layer: the viewer's own.
        expect(screen.findByTestId('project-context.shared.add')).toBeNull();
        expect(screen.findByTestId('project-context.personal.add')).toBeTruthy();
        expect(rowTitle('project-context.personal.guide-entry')).toBe('API style guide');

        // The memory document is the memory section's, never a second row in the list.
        expect(screen.findByTestId('project-context.personal.memory-entry')).toBeNull();
        expect(screen.findByTestId('project-context.memory.detach')).toBeTruthy();

        // A document this Account cannot read keeps its row and its Remove, but never a guessed title.
        expect(rowTitle('project-context.personal.gone-entry')).toBe('contextPages.project.privateDocument');
        const actionIds = screen.findAllByType('ItemRowActions' as never).map((node) => (node.props.actions as { id: string }[]).map((action) => action.id));
        expect(actionIds).toContainEqual(['delete']);
        expect(actionIds).toContainEqual(['edit', 'moveUp', 'moveDown', 'delete']);
    });

    it('does not substitute personal memory for an unavailable Source-owned Project memory', async () => {
        const screen = await renderScreen(<ProjectContextBody workspaceRef={{ ...workspaceRef,
            source: { sourceId: 'source-1', revision: 1 },
        }} />);
        // Retained personal memory remains a personal document; it is not the Source's memory.
        expect(Boolean(screen.findByTestId('project-context.personal.memory-entry'))).toBe(true);
        expect(Boolean(screen.findByTestId('project-context.memory.detach'))).toBe(false);
        expect(Boolean(screen.findByTestId('project-context.memory.remember'))).toBe(false);
    });
});
