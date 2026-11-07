import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const routerPush = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({ storage: 'real', router: async () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
    useNavigation: () => ({ setOptions: vi.fn() }), useLocalSearchParams: () => ({}),
}) });
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetTeamsSnapshotsForTests(); resetTeamsDirectoryEngineForTests(); resetTeamActionClientForTests(); resetWorkflowLibraryReadsForTests();
    await home.reset(); await home.selectHomes([]); routerPush.mockReset();
});
afterEach(standardCleanup);

describe('Team overview Workflow library', () => {
    it('shows only definitions admitted for this Team and opens them on their Home', async () => {
        const serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://team-workflows.test', accountId: 'account-ada', teamsEnabled: true });
        await home.selectHomes([serverId]);
        home.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({ viewRoster: true }) }) });
        home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] });
        const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
        for (const [index, id] of ids.entries()) home.artifacts(serverId).replaceStoredRow({
            id, ownerAccountId: 'account-ada', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            kind: 'other', kindHint: 'workflow-definition.v1', sharedTeamIds: index === 0 ? ['team-1'] : index === 1 ? ['other-team'] : [],
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: id, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Workflow ${index}` } }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: index + 1, createdAt: 1, updatedAt: index + 1,
        });
        const { TeamOverviewScreen } = await import('./TeamOverviewScreen');
        const screen = await renderScreen(<TeamOverviewScreen serverId={serverId} teamId="team-1" />);
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`team-overview-workflow:${ids[0]}`));
        const testIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(testIds).not.toContain(`team-overview-workflow:${ids[1]}`);
        expect(testIds).not.toContain(`team-overview-workflow:${ids[2]}`);
        screen.pressByTestId(`team-overview-workflow:${ids[0]}`);
        expect(routerPush).toHaveBeenCalledWith(`/workflows/${ids[0]}?serverId=${serverId}`);
    });
});
