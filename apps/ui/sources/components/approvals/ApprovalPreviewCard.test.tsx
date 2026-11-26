import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineSetupApplyInputV1Schema, MachineSetupRemoveInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import recordedAgentApply from './ApprovalPreviewCard.machineSetupRecorded.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const routerHandle = vi.hoisted(() => ({ current: null as null | { spies: { push: { mock: { calls: unknown[][] } } } } }));
installApprovalCommonModuleMocks({
    text: () => vi.importActual<typeof import('@/text')>('@/text'),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const router = createExpoRouterMock();
        routerHandle.current = router;
        return router.module;
    },
});
afterEach(() => standardCleanup());

const { ApprovalPreviewCard } = await import('./ApprovalPreviewCard');
const body = '#!/bin/bash\nroot="$HOME"\nprintf "%s\\n" "${root}"\n';
const checkBody = 'test -d /example/vendor\n';
const selection = { ref: { pluginId: 'example.software', recipeId: 'installer', revision: '1' }, inputs: {} };
const plan = { v: 1, basis: { kind: 'setup', machineId: 'vps', desiredRevision: 1, selection },
    steps: [{ id: 'installer', kind: 'script', shell: 'bash', body,
        check: { body: checkBody, unsatisfiedExitCodes: [1] } }],
    nativeFacts: [{ stepId: 'installer', status: 'satisfied', facts: {} }], planDigest: 'a'.repeat(64) };

describe('ApprovalPreviewCard reviewed Machine scripts', () => {
    it.each(['apply', 'remove'] as const)('shows the exact %s recipe body and check from the approved input', async (operation) => {
        const actionArgs = operation === 'apply'
            ? MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'vps', targets: [{
                homeId: 'home', machineId: 'vps', desiredRevision: 1,
                sources: [{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection }] } }],
                recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
            }] })
            : MachineSetupRemoveInputV1Schema.parse({ homeId: 'home', machineId: 'vps', desiredRevision: 1,
                sources: [{ kind: 'direct', setup: { scripts: [{ body: 'retained source is not a removal effect' }] } }],
                removeItemKeys: ['owned'], removalPlans: [{ itemKey: 'owned', plan }],
            });
        const screen = await renderScreen(<ApprovalPreviewCard
            preview={{ summary: 'Review setup', body: 'unreviewed preview replacement' }}
            request={{ actionId: `machines.setup.${operation}`, actionArgs }} />);
        // Text-content helpers collapse whitespace. Exact Text children prove
        // shell quoting, newlines and the final newline survive presentation.
        expect(screen.tree.findAll(node => node.props?.children === body).length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.children === checkBody).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('unreviewed preview replacement');
        expect(screen.getTextContent()).not.toContain('retained source is not a removal effect');
        await screen.unmount();
    });

    it('shows exactly the scripts the admitted Plan runs, naming a retained copy it cannot open', async () => {
        const actionArgs = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'vps', targets: [{
            homeId: 'home', machineId: 'vps', desiredRevision: 4, recipePlans: [], sources: [
                { kind: 'accountPresetOpaque', presetId: 'retained', presetRevision: 1, contentEncryptionMode: 'e2ee' },
                { kind: 'direct', setup: { scripts: [{ body: 'echo already-done' }, { body: 'printf TEAM' }] } },
            ] }] });
        // The host's admission preview carries the target Plan's own script review.
        const review = { steps: [{ planIndex: 0, stepId: 'script:1', label: 'Script 2' }, { planIndex: 0, stepId: 'script:3', label: 'Script 4' }],
            presetUpdateEffects: { toolchain: false, scripts: [{ sourceIndex: 0, scriptIndex: 1 }, { sourceIndex: 1, scriptIndex: 1 }] } };
        const screen = await renderScreen(<ApprovalPreviewCard
            preview={{ summary: 'Review setup', deploymentReview: { kind: 'machineSetup', scripts: [{ targetIndex: 0, homeId: 'home', machineId: 'vps', review }] } }}
            request={{ actionId: 'machines.setup.apply', actionArgs }} />);
        expect(screen.getTextContent()).toContain('Script 2');
        expect(screen.getTextContent()).toContain('$ printf TEAM');
        expect(screen.getTextContent()).not.toContain('already-done');
        await screen.unmount();
    });

    it('reads the recorded agent Apply approval: every script the Plan runs, from its deployment review', async () => {
        // Exact `approval.request.get` request fields from a live standalone-MCP Apply (TS-QA-AGENT-3, cut 6b16c88d6aa).
        const screen = await renderScreen(<ApprovalPreviewCard preview={recordedAgentApply.preview}
            request={{ actionId: recordedAgentApply.actionId, actionArgs: recordedAgentApply.actionArgs }} />);
        const text = screen.getTextContent();
        expect(recordedAgentApply.preview.deploymentReview.scripts[0]?.review.steps).toHaveLength(33);
        for (let index = 1; index <= 33; index++) expect(text).toContain(`Script ${index}`);
        expect(text).not.toContain('Not known');
        await screen.unmount();
    });

    it('says a Team setup batch runs scripts it cannot show instead of showing no change', async () => {
        const machine = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'vps', targets: [{
            homeId: 'home', machineId: 'vps', desiredRevision: 4, recipePlans: [], sources: [
                { kind: 'accountPresetOpaque', presetId: 'team-tools', presetRevision: 1, contentEncryptionMode: 'e2ee' },
                { kind: 'direct', setup: { scripts: [{ body: 'printf DIRECT' }] } },
            ] }] });
        const screen = await renderScreen(<ApprovalPreviewCard preview={{ summary: 'Review Team setup' }}
            request={{ actionId: 'teams.setup.run', actionArgs: { serverId: 'home', homeId: 'home', machineId: 'vps', machine, repositories: [] } }} />);
        expect(screen.findByTestId('approvals.preview.commands')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('printf DIRECT');
        await screen.unmount();
    });

    it('does not present an invalid setup payload as a reviewed script', async () => {
        const screen = await renderScreen(<ApprovalPreviewCard preview={{ summary: 'Review setup' }}
            request={{ actionId: 'machines.setup.apply', actionArgs: { recipePlans: [{ plan }] } }} />);
        expect(screen.getTextContent()).toContain('Review setup');
        expect(screen.getTextContent()).not.toContain(body.trim());
        await screen.unmount();
    });

    it('keeps an ordinary approval summary usable without interpreting recipe-shaped arguments', async () => {
        const screen = await renderScreen(<ApprovalPreviewCard preview={{ summary: 'Review ordinary action' }}
            request={{ actionId: 'example.ordinary', actionArgs: { recipePlans: [{ plan }] } }} />);
        expect(screen.getTextContent()).toContain('Review ordinary action');
        expect(screen.getTextContent()).not.toContain(body.trim());
        await screen.unmount();
    });
});

describe('ApprovalPreviewCard administrator access (P-M6)', () => {
    const request = (mode: 'preauthorized' | 'ask') => ({ actionId: 'machines.setup.adminAccess.set', actionArgs: {
        machineId: 'vps', expectedMetadataVersion: 3, expectedAdminAccess: { version: 1, mode: 'none' },
        adminAccess: mode === 'ask' ? { version: 1, mode, administratorUsername: 'deploy' } : { version: 1, mode },
        comparison: 'field',
    } });

    it('says a preauthorization is a permission change first and offers separate users from the Security page', async () => {
        const screen = await renderScreen(<ApprovalPreviewCard preview={{ summary: 'Set administrator access' }}
            request={request('preauthorized')} serverId="server-a" />);
        expect(screen.findByTestId('approvals.preview.permission')).not.toBeNull();
        await screen.pressByTestIdAsync('approvals.preview.permission.action');
        const pushed = String(routerHandle.current?.spies.push.mock.calls.at(-1)?.[0]);
        expect(pushed).toContain('/vps?');
        expect(pushed).toContain('tab=security');
        expect(pushed).toContain('serverId=server-a');
        await screen.unmount();
    });

    it('asks nothing extra when access stays Ask each time', async () => {
        const screen = await renderScreen(<ApprovalPreviewCard preview={{ summary: 'Set administrator access' }}
            request={request('ask')} serverId="server-a" />);
        expect(screen.findByTestId('approvals.preview.permission')).toBeNull();
        await screen.unmount();
    });
});
