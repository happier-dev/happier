import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
await import('@/components/dev/approvals/ApprovalCardSpecimen');
const { describeApprovalActionFields } = await import('./approvalFieldValues');
const { readProjectCommandApproval } = await import('./ProjectCommandApprovalFacts');
const { storage } = await import('@/sync/domains/state/storage');
beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });
it.each([true, false])('shares Project command reference names and disclosure (readable: %s)', async readable => {
    const home = await harness.addHome({ name: 'Script Home', serverUrl: 'https://script-review.test', accountId: 'runner' });
    const machineId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    storage.getState().applyMachines(readable ? [createMachineFixture({ id: machineId,
        metadata: createMachineMetadataFixture({ displayName: 'Studio runner' }) })] : [], true, { sourceServerId: home });
    const screen = await renderScreen(<ApprovalReviewFacts actionId="projects.script.run" actionArgs={{
        workspace: { serverId: home, workspaceId: 'checkout', machineId, rootPath: '/workspace/project' },
        selection: { kind: 'named', name: 'build release' }, choice: { kind: 'primary' },
    }} preview={null} status="open" serverId={home} testID="script-review" />);
    expect(screen.getTextContent()).toContain('build release');
    expect(screen.getTextContent()).toContain('/workspace/project');
    expect(screen.getTextContent()).toContain(readable ? 'Studio runner' : '—');
    expect(screen.getTextContent()).not.toContain(machineId);
    await screen.pressByTestIdAsync('approvals.technical-details.header');
    expect(screen.getTextContent()).toContain(machineId);
    await screen.unmount();
});

it('declares Script source and worker references at the field projection owner', () => {
    const workspace = { serverId: 'script-home', workspaceId: 'checkout', machineId: 'source-machine', rootPath: '/work/project' };
    for (const destination of [{ kind: 'machine', machineId: 'worker-machine' }, { kind: 'pool', poolId: '11111111-1111-4111-8111-111111111111', selection: 'automatic' }] as const) {
        const fields = describeApprovalActionFields({ actionId: 'projects.script.run', actionArgs: {
            workspace, selection: { kind: 'named', name: 'build' }, choice: { kind: 'workers', destination },
        } });
        const references: unknown[] = [];
        const visit = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            if ('reference' in value) references.push(value.reference);
            for (const child of Object.values(value)) visit(child);
        };
        visit(fields);
        expect(references).toContainEqual({ kind: 'machine', id: workspace.machineId, serverId: workspace.serverId });
        expect(references).toContainEqual(destination.kind === 'machine'
            ? { kind: 'machine', id: destination.machineId, serverId: workspace.serverId }
            : { kind: 'machinePool', id: destination.poolId });
    }
});
it('does not flatten a managed V2 checkout onto its controller Machine', () => {
    const workspace = { v: 2, kind: 'managed', serverId: 'script-home', workspaceId: 'guest-checkout',
        managedId: 'guest', controller: { machineId: 'controller-machine', installationId: 'controller-installation' }, rootPath: '/guest/project' };
    // The current Script Action accepts V1 only; the preview must not reinterpret a rejected native address.
    expect(readProjectCommandApproval({ actionId: 'projects.script.run', actionArgs: {
        workspace, selection: { kind: 'named', name: 'build' }, choice: { kind: 'primary' },
    } })).toBeNull();
});
