import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentMachineResultV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentReadControllerV1 } from '../controller/createDeploymentReadControllerV1.js';
import type { DeploymentReadTransportV1 } from '../controller/deploymentReadControllerTypes.js';
import { createDeploymentMemberVersionProjectionV1, deriveDeploymentMemberVersionsV1 } from './deploymentStepProjection.js';

const demand = { mounted: true, visible: true, focused: true };
const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
const members = ['a', 'b', 'c'].map(id => ({ machineId: `machine-${id}`, installationId: `installation-${id}`, state: 'active' as const }));
function result(index: number, deploymentId: string, overrides: Partial<DeploymentMachineResultV1> = {}): DeploymentMachineResultV1 {
    const { state: _state, ...identity } = members[index]!;
    return { ...identity, steps: [], activation: 'succeeded', health: 'healthy', currentDeploymentId: deploymentId, ...overrides };
}
function receipt(id: string, time: number, results: DeploymentMachineResultV1[], state: DeploymentReceiptDetailV1['deployment']['state'] = 'failed') {
    const base = createDeploymentReceiptDetailV1();
    return createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id, requestedAtMs: time, state }),
        content: { ...base.content, machines: members.map(member => member.machineId), machineResults: results } });
}
function harness(receipts: Map<string, DeploymentReceiptDetailV1>) {
    const environment = createDeploymentEnvironmentDetailV1({ targetLinks: [{
        targetLink: createDeploymentTargetLinkHeaderV1({ machines: members.map(member => member.machineId), members, activeDeploymentId: 'u1' }), content: {},
    }] });
    const transport: DeploymentReadTransportV1 = {
        listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        readEnvironment: async () => ({ ok: true, value: structuredClone(environment) }),
        readReceipt: async (_scope, _environment, id) => ({ ok: true, value: structuredClone(receipts.get(id)) }),
    };
    const controller = createDeploymentReadControllerV1({ scope, transport });
    return { controller, environment: controller.acquireEnvironment(environment.environment.id, demand) };
}

describe('receipt-derived current member versions', () => {
    it('reads member proof only until every current installation has a newest authoritative version', () => {
        const link = createDeploymentTargetLinkHeaderV1({ machines: members.map(member => member.machineId), members });
        let proofReads = 0;
        // Plan 40 §12's retained-history scale control.
        const history = Array.from({ length: 100 }, (_item, index) => {
            const item = receipt(`release-${index}`, index + 1,
                members.map((_member, memberIndex) => result(memberIndex, `release-${index}`)), 'succeeded');
            const machineResults = item.content.machineResults;
            Object.defineProperty(item.content, 'machineResults', { get() { proofReads++; return machineResults; } });
            return item;
        });
        expect(deriveDeploymentMemberVersionsV1(link, history)).toMatchObject(Object.fromEntries(members.map(member =>
            [member.machineId, { deploymentId: 'release-99', uncertain: false }])));
        expect(proofReads).toBe(1);
    });
    it('folds a growing retained history once while searching only unresolved installations', () => {
        const selectedMembers = members.slice(0, 2);
        const link = createDeploymentTargetLinkHeaderV1({ machines: selectedMembers.map(member => member.machineId), members: selectedMembers });
        const projection = createDeploymentMemberVersionProjectionV1(link);
        let proofReads = 0;
        for (let index = 99; index >= 0; index--) {
            const item = receipt(`release-${index}`, index + 1,
                [result(0, `release-${index}`), ...(index === 0 ? [result(1, 'release-0')] : [])], 'succeeded');
            const machineResults = item.content.machineResults;
            Object.defineProperty(item.content, 'machineResults', { get() { proofReads++; return machineResults; } });
            expect(projection.addReceipt(item)).toBe(index === 0);
        }
        expect(projection.getVersions()).toMatchObject({
            'machine-a': { deploymentId: 'release-99', uncertain: false },
            'machine-b': { deploymentId: 'release-0', uncertain: false },
        });
        expect(proofReads).toBe(100);
    });
    it('preserves proving common-member versions across admitted link replacement without guessing a joining member', () => {
        const link = createDeploymentTargetLinkHeaderV1({ id: 'replacement-link', predecessorTargetLinkId: 'previous-link',
            activeDeploymentId: 'u1', machines: members.map(member => member.machineId),
            members: members.map((member, index) => ({ ...member, state: index === 2 ? 'joining' : 'active' })) });
        const prior = (value: DeploymentReceiptDetailV1) => ({ ...value,
            deployment: { ...value.deployment, targetLinkId: 'previous-link' } });
        const uniform = prior(receipt('u1', 1, [result(0, 'u1'), result(1, 'u1')], 'succeeded'));
        const partial = prior(receipt('v2', 2, [result(0, 'v2'), result(1, 'u1', { activation: 'failed' })]));
        const foreign = receipt('foreign-link-release', 3, [result(1, 'foreign-link-release')], 'succeeded');
        const expected = {
            'machine-a': { deploymentId: 'v2', uncertain: false },
            'machine-b': { deploymentId: 'u1', uncertain: false },
            'machine-c': { state: 'joining', deploymentId: null, uncertain: true },
        };
        expect(deriveDeploymentMemberVersionsV1(link, [uniform, partial, foreign])).toMatchObject(expected);
        const later = { ...link, id: 'later-link', predecessorTargetLinkId: link.id };
        expect(deriveDeploymentMemberVersionsV1(later, [uniform, partial, foreign], [link])).toMatchObject(expected);
    });
    it('does not guess a final identity after failed restoration and preserves activation when compensation never dispatched', async () => {
        const receipts = new Map([
            ['u1', receipt('u1', 1, [result(0, 'u1')], 'succeeded')],
            ['v2', receipt('v2', 2, [result(0, 'v2', { restoration: 'failed' })])],
            ['v3', receipt('v3', 3, [result(0, 'v3', { restoration: 'unreachable' })])],
        ]);
        const { controller, environment } = harness(receipts);
        await environment.refresh();
        for (const id of ['u1', 'v2']) await controller.acquireReceipt('environment-staging', id, demand).refresh();
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: { 'machine-a': { deploymentId: 'u1', uncertain: true } } });
        await controller.acquireReceipt('environment-staging', 'v3', demand).refresh();
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: { 'machine-a': { deploymentId: 'v3', uncertain: false } } });
        controller.retire();
    });
    it('does not treat a different runtime link as proof for the selected workload on the same installation', async () => {
        const foreign = receipt('foreign', 4, [result(0, 'foreign')], 'succeeded');
        const receipts = new Map([['foreign', { ...foreign, deployment: { ...foreign.deployment, targetLinkId: 'other-link' } }]]);
        const { controller, environment } = harness(receipts);
        await environment.refresh();
        const opened = controller.acquireReceipt('environment-staging', 'foreign', demand);
        await opened.refresh();
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: { 'machine-a': { deploymentId: null, uncertain: true } } });
        controller.retire();
    });
    it('keeps last uniform separate from keepPartial and takes final restoration rather than each member predecessor', async () => {
        const receipts = new Map([
            ['u1', receipt('u1', 1, members.map((_member, index) => result(index, 'u1')), 'succeeded')],
            ['v2', receipt('v2', 2, [result(0, 'v2'), result(1, 'u1', { activation: 'failed' }), result(2, 'v2')])],
            ['v3', receipt('v3', 3, members.map((_member, index) => result(index, 'u1', {
                previousDeploymentId: index === 0 || index === 2 ? 'v2' : 'u1', restoration: 'succeeded',
                ...(index === 2 ? { activation: 'outcome_unknown' } : {}),
            })))],
        ]);
        const { controller, environment } = harness(receipts);
        await environment.refresh();
        const uniform = controller.acquireReceipt('environment-staging', 'u1', demand);
        const partial = controller.acquireReceipt('environment-staging', 'v2', demand);
        await Promise.all([uniform.refresh(), partial.refresh()]);
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: {
            'machine-a': { deploymentId: 'v2', uncertain: false }, 'machine-b': { deploymentId: 'u1', uncertain: false }, 'machine-c': { deploymentId: 'v2', uncertain: false },
        }, targetLinks: [{ targetLink: { activeDeploymentId: 'u1' } }] });
        const unchanged = environment.getSnapshot().value!.memberVersions['machine-b'];
        const compensation = controller.acquireReceipt('environment-staging', 'v3', demand);
        await compensation.refresh();
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: Object.fromEntries(members.map(member => [member.machineId, { deploymentId: 'u1', uncertain: false }])) });
        expect(environment.getSnapshot().value!.memberVersions['machine-b']).toBe(unchanged);
        const published = vi.fn();
        environment.subscribe(published);
        receipts.set('v3', { ...receipts.get('v3')!, content: { ...receipts.get('v3')!.content, machineResults: [...receipts.get('v3')!.content.machineResults].reverse() } });
        await compensation.refresh();
        await environment.refresh();
        expect(published).not.toHaveBeenCalled();
        controller.retire();
    });

    it('retains older authoritative identity through unknown/unvisited work and does not guess from uniform or a foreign installation', async () => {
        const receipts = new Map([
            ['u1', receipt('u1', 1, [result(0, 'u1'), result(1, 'u1', { installationId: 'old-installation' }), result(2, 'u1')], 'succeeded')],
            ['v2', receipt('v2', 2, [result(0, 'v2', { activation: 'outcome_unknown' }), result(1, 'v2', { activation: 'pending' }),
                result(2, 'v2', { currentDeploymentId: undefined })], 'outcome_unknown')],
        ]);
        const { controller, environment } = harness(receipts);
        await environment.refresh();
        const uniform = controller.acquireReceipt('environment-staging', 'u1', demand);
        const unknown = controller.acquireReceipt('environment-staging', 'v2', demand);
        await Promise.all([uniform.refresh(), unknown.refresh()]);
        expect(environment.getSnapshot().value).toMatchObject({ memberVersions: {
            'machine-a': { deploymentId: 'u1', uncertain: true }, 'machine-b': { deploymentId: null }, 'machine-c': { deploymentId: 'u1', uncertain: true },
        } });
        controller.retire();
    });
});
