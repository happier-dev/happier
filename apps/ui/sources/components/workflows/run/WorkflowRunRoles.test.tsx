import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRoleSelectionV1, type RoleOverrideV1 } from '@happier-dev/protocol';
import { PromptLibraryRowsListResponseV1Schema, sealPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { WorkflowAcceptedRunRoles, WorkflowRunRoles } = await import('./WorkflowRunRoles');
let disposeLoader: (() => void) | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

await loadSyncSingletonForTests();

const definition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'portable_builder' } }, roles: [{
    roleId: 'portable_builder', name: 'Accepted builder', instructions: 'Build carefully', runsAs: { kind: 'session' },
}] });

describe('workflow run role controls', () => {
    beforeEach(async () => {
        await home.reset();
        disposeLoader = await installRealActionExecutorModuleLoader();
        const serverUrl = `https://workflow-roles-${crypto.randomUUID()}.test`;
        const serverId = await home.addHome({ name: 'Workflow roles', serverUrl, accountId: 'account-a', currentAccount: true });
        home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(serverId, '/v1/account/entity-rows/prompt-library', { body: PromptLibraryRowsListResponseV1Schema.parse({
            status: 'listed', rows: [{ key: 'role-overrides', revision: 1, content: sealPromptLibraryContentV1({
                record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, mode: 'plain', material: null,
            }) }],
        }) });
        connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a', request: home.request,
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) } });
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
        retireActiveServerAccountScopeLifetime();
        await home.reset();
        disposeLoader?.();
        disposeLoader = undefined;
    });

    it('edits one run-layer field and Use your role removes only that role override', async () => {
        const onChange = vi.fn();
        const other: RoleOverrideV1 = { roleId: 'other_role', secondOpinion: 'encouraged' };
        function Host() {
            const [overrides, setOverrides] = React.useState<readonly RoleOverrideV1[]>([
                { roleId: 'portable_builder', workspaceWrites: 'deny' }, other,
            ]);
            return <WorkflowRunRoles definition={definition} roleIds={['portable_builder']} overrides={overrides}
                pending={false} prefix="run" onChange={(next) => { setOverrides(next); onChange(next); }} />;
        }
        const screen = await renderScreen(<Host />);
        await vi.waitFor(() => expect(screen.findByTestId('run-role-portable_builder-target:background_run')).not.toBeNull());
        await screen.pressByTestIdAsync('run-role-portable_builder-target:background_run');
        expect(onChange).toHaveBeenLastCalledWith([other, {
            roleId: 'portable_builder', workspaceWrites: 'deny', runsAs: { kind: 'background_run', intent: 'task' },
        }]);
        await screen.pressByTestIdAsync('run-role-portable_builder-reset');
        expect(onChange).toHaveBeenLastCalledWith([other]);
        expect(definition.roles?.[0]?.runsAs).toEqual({ kind: 'session' });
    });

    it('renders frozen role facts without reading today’s mutable role catalog', async () => {
        const acceptedRole = resolveRoleSelectionV1({ roleId: 'portable_builder', workflowRoles: definition.roles });
        if (!acceptedRole.ok) throw new Error('invalid_role_fixture');
        const screen = await renderScreen(<WorkflowAcceptedRunRoles leaves={[{ sourceKey: '$root', blockId: 'analyze', kind: 'step',
            selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, role: acceptedRole.selection }]} />);
        expect(screen.getTextContent()).toContain('Accepted builder');
        expect(home.requestsFor('/v1/artifacts')).toEqual([]);
        expect(home.requestsFor('/v1/account/entity-rows/prompt-library')).toEqual([]);
        expect(screen.findByTestId('run-role-portable_builder-engine')).toBeNull();
    });

    // F-JOURNEY-UI live: "Keep going until done" listed its review role as "Second opinion" while Work, Run and
    // Roles settings read "Independent check"; the role's display name has one owner.
    it('names the second_opinion role through the shared role display name, editable and frozen', async () => {
        const reviewDefinition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'second_opinion' } }, roles: [{
            roleId: 'second_opinion', name: 'Second opinion', instructions: 'Check the work', runsAs: { kind: 'session' },
        }] });
        const editable = await renderScreen(<WorkflowRunRoles definition={reviewDefinition} roleIds={['second_opinion']}
            overrides={[]} pending={false} prefix="run" onChange={() => {}} />);
        await vi.waitFor(() => expect(editable.findByTestId('run-role-second_opinion-reset')).toBeNull());
        await vi.waitFor(() => expect(editable.getTextContent()).toContain('roles.settings.secondOpinionTitle'));
        expect(editable.getTextContent()).not.toContain('Second opinion');
        await editable.unmount();
        const accepted = resolveRoleSelectionV1({ roleId: 'second_opinion', workflowRoles: reviewDefinition.roles });
        if (!accepted.ok) throw new Error('invalid_role_fixture');
        const frozen = await renderScreen(<WorkflowAcceptedRunRoles leaves={[{ sourceKey: '$root', blockId: 'check', kind: 'step',
            selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, role: accepted.selection }]} />);
        expect(frozen.getTextContent()).toContain('roles.settings.secondOpinionTitle');
        expect(frozen.getTextContent()).not.toContain('Second opinion');
    });
});
