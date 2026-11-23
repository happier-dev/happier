import * as React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { MACHINE_PRESET_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { MACHINE_POOL_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import machineCatalogCases from './ApprovalReviewFacts.machineCatalog.cases.json';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const presetId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const poolId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const machineId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const homeId = 'srv_preset_review';

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(() => {
    setPreferredLanguageFromSettings('en');
    standardCleanup();
});

it.each([
    { readable: true, description: null },
    { readable: false, description: null },
    { readable: true, description: undefined },
])('reads a Pool replacement under the viewing Account ($readable, description $description)', async ({ readable, description }) => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://pool-review.test', accountId: 'reviewer' });
    if (readable) storage.getState().applyMachines([createMachineFixture({ id: machineId,
        metadata: createMachineMetadataFixture({ displayName: 'Build runner' }) })], true, { sourceServerId: serverId });
    harness.answer(serverId, 'POST /v1/machines/pools/get', readable ? {
        body: { pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Compile farm' }, recipientEnvelope: null } },
            description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] },
        availability: { state: 'unknown' } },
    } : { status: 404, body: { code: 'pool_not_found' } });
    const actionId = 'machines.pools.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ poolId, expectedRevision: 1,
        name: 'Build farm', ...(description === undefined ? {} : { description }),
        members: [{ machineId, priorityTier: 1, enabled: true }] });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="pool-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(readable ? 'Compile farm' : t('common.unavailable')));
        expect(screen.getTextContent()).toContain(readable ? 'Build runner' : t('common.unavailable'));
        expect(screen.getTextContent()).toContain(t('approvals.clearsField', { field: 'Description' }));
        expect(screen.getTextContent()).not.toContain(poolId);
        expect(screen.getTextContent()).not.toContain(machineId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(poolId);
        expect(screen.getTextContent()).toContain(machineId);
    } finally { await screen.unmount(); }
});

it.each(['named', 'archived', 'unreadable'])('reads a %s preset by its name', async (state) => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://preset-review.test',
        serverIdentityId: homeId, accountId: 'reviewer' });
    const name = state === 'archived' ? 'Original build image' : 'Current build image';
    const preset = ManagedMachinePresetV1Schema.parse({ id: presetId, homeId, revision: 1,
        owner: { kind: 'account', accountId: 'reviewer' }, contentEncryptionMode: 'plain', recipients: [],
        ...(state === 'archived' ? { archivedAt: 1 } : {}),
        content: { t: 'plain', v: { v: 1, name, launch: { name: 'Guest',
            provider: { pluginId: 'developer.example', localId: 'machines' }, schemaVersion: 1, choices: {} } } } });
    harness.answer(serverId, 'POST /v1/machines/presets/get', { body: state === 'unreadable'
        ? { kind: 'refused', code: 'preset_not_found' }
        : { kind: 'found', preset } });
    const actionId = state === 'archived' ? 'machines.presets.restore' : 'machines.presets.archive';
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} status="open" preview={null}
        serverId={serverId} actionArgs={getActionSpec(actionId).inputSchema.parse({ homeId, id: presetId, expectedRevision: 1 })}
        testID="preset-reference" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(state === 'unreadable' ? t('common.unavailable') : name));
        expect(screen.getTextContent()).not.toContain(presetId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(presetId);
    } finally { await screen.unmount(); }
});

it.each([
    ['controller', 'Controller'],
    ['controllerPoolId', 'Controller pool'],
    ['retention', 'Retention policy'],
    ['wakeOnAcceptedMessage', 'Wake on accepted message'],
    ['simultaneousLimit', 'Simultaneous machine limit'],
])('shows a cleared preset %s distinctly from an omitted patch', async (field, label) => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://preset-review.test', accountId: 'reviewer' });
    const actionId = 'machines.presets.update';
    const spec = getActionSpec(actionId);
    const input = { homeId: serverId, id: presetId, expectedRevision: 1 };
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={spec.inputSchema.parse({ ...input, patch: { [field]: null } })}
        preview={null} status="open" serverId={serverId} testID="preset-review" />);
    try {
        expect(screen.getTextContent()).toContain(t('approvals.clearsField', { field: label }));
    } finally { await screen.unmount(); }
    const omitted = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={spec.inputSchema.parse({ ...input, patch: {} })}
        preview={null} status="open" serverId={serverId} testID="preset-review" />);
    try {
        expect(omitted.getTextContent()).not.toContain(label);
    } finally { await omitted.unmount(); }
});

const authoredFields = new Set(['name', 'description', 'path', 'url', 'address', 'modelId']);
const opaqueIdentifier = /\b(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|c[a-z0-9]{24})\b/gi;
const codeLiteral = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function reviewOperands(input: unknown, authored = false): { value: string; authored: boolean }[] {
    if (typeof input === 'string') return [{ value: input, authored }];
    if (Array.isArray(input)) return input.flatMap(value => reviewOperands(value, authored));
    if (input === null || typeof input !== 'object') return [];
    return Object.entries(input).flatMap(([key, value]) => reviewOperands(value, authored || authoredFields.has(key)));
}

function hostText(node: ReactTestInstance): string {
    return node.children.map(child => typeof child === 'string' ? child : hostText(child)).join(' ');
}

it('has schema-valid review cases for every Preset and Pool Action', () => {
    expect(new Set(machineCatalogCases.map(row => row.actionId))).toEqual(new Set([
        ...MACHINE_PRESET_ACTION_IDS_V1, ...MACHINE_POOL_ACTION_IDS_V1,
    ]));
});

it.each(machineCatalogCases)('keeps $actionId free of technical operands and untranslated sentences', async ({ actionId, cases }) => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://catalog-review.test',
        serverIdentityId: homeId, accountId: 'reviewer' });
    const spec = getActionSpec(ActionIdSchema.parse(actionId));
    const scenarios = cases.map(input => {
        const actionArgs = spec.inputSchema.parse(input);
        return { actionArgs, summary: buildApprovalPreviewSummary(spec, actionArgs) };
    });
    expect(scenarios.length).toBeGreaterThan(0);
    const defects: { index: number; visible: string[] }[] = [];
    for (let offset = 0; offset < scenarios.length; offset += 12) {
        const batch = scenarios.slice(offset, offset + 12);
        const screen = await renderScreen(<>{batch.map(({ actionArgs, summary }, index) => (
            <View key={index} testID={`catalog-case-${index}`}>
                <ApprovalReviewFacts actionId={actionId} status="open" actionArgs={actionArgs}
                    preview={{ summary }} serverId={serverId} testID={`catalog-review-${index}`} />
            </View>
        ))}</>);
        try {
            await flushHookEffects({ cycles: 12 });
            batch.forEach(({ actionArgs, summary }, index) => {
                let text = hostText(screen.findHostByTestId(`catalog-case-${index}`)!);
                const operands = reviewOperands(actionArgs);
                for (const operand of operands) {
                    if (!operand.authored || !operand.value || operands.some(other => !other.authored && other.value === operand.value)) continue;
                    // The exact author-supplied value is permitted. Coincident routing operands stay checked.
                    text = text.replaceAll(operand.value, '');
                }
                const visibleTokens = new Set(text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g));
                const visible = [
                    ...new Set(text.match(opaqueIdentifier)),
                    ...operands.filter(operand => !operand.authored && codeLiteral.test(operand.value)
                        && visibleTokens.has(operand.value)).map(operand => operand.value),
                    ...(spec.approvalPresentation?.summary?.(actionArgs) && summary !== spec.title + '.' && text.includes(summary) ? [summary] : []),
                ];
                if (visible.length > 0) defects.push({ index: offset + index, visible });
            });
        } finally {
            await screen.unmount();
        }
    }
    expect(defects).toEqual([]);
});
