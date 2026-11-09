import * as React from 'react';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { ReviewEngineListItemSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { z } from 'zod/mini';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import type { SelectionListSection, SelectionListOption } from '@/components/ui/selectionList';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { SelectionList } = await import('@/components/ui/selectionList');
const { SessionInteractiveExecutionRunDraftView } = await import('@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('Review inventory order through Start selection', () => {
    it.each([
        { disabled: false, preselected: undefined, expected: null },
        { disabled: true, preselected: undefined, expected: null },
        { disabled: false, preselected: ['antigravity'], expected: 'antigravity' },
    ])('keeps catalog order and explicit reviewer choice ($expected, disabled=$disabled)', async ({ disabled, preselected, expected }) => {
        const variant = disabled ? 'disabled' : preselected ? 'retry' : 'default';
        const serverUrl = `https://review-order-${variant}.test`;
        const serverIdentityId = `srv_review_order_${variant}`;
        // The daemon producer and UI consumer share their real public inventory. Only HTTP is replaced.
        // Load the other host at runtime: each host's @ alias belongs to its own compiler project.
        // The public inventory schema admits the output at this cross-program test boundary.
        const producerPath = fileURLToPath(new URL('../../../../../cli/src/session/actions/inventory/buildReviewEngineInventoryItems.ts', import.meta.url));
        const producer: unknown = await import(/* @vite-ignore */ producerPath);
        if (!producer || typeof producer !== 'object' || !('buildReviewEngineInventoryItems' in producer)
            || typeof producer.buildReviewEngineInventoryItems !== 'function') throw new Error('Review inventory producer unavailable');
        const items = z.array(ReviewEngineListItemSchema).parse(await producer.buildReviewEngineInventoryItems({
            includeDisabled: true,
            accountSettings: AccountSettingsSchema.parse({ backendEnabledByTargetKey: disabled
                ? { 'agent:happier.agent.claude/claude': false } : {} }),
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
        }));
        const inventoryBoundary = await createExternalActionAccountHttpBoundary({
            serverUrl, serverIdentityId, accountId: 'alice',
            machineId: 'm1', tokenEpoch: 0, actionId: 'review.engines.list', requesterInvocation: 'none',
            execute: () => ({ sessionId: null, items }),
        });
        const machineInventory = createReadyMachineAgentInventoryFixture(items.map(item => ({ agentId: item.engineId, title: item.label })));
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverUrl,
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId,
            machine: createMachineFixture({ id: 'm1', kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                installationId: 'test-installation', storageMode: 'plain', access: createPlainMachineRowFixture({ id: 'm1', accountId: 'alice' }).access }),
            rpc: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: machineInventory.projection }
                : method === RPC_METHODS.CAPABILITIES_DETECT ? { ...machineInventory.capabilities, results: {
                    ...machineInventory.capabilities.results,
                    'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2,
                        backends: Object.fromEntries(items.map(item => [item.engineId, { available: item.enabled, intents: ['review'] }])),
                        features: { startAndWait: true, detachedScope: true } } },
                } }
                : { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
                }));
                return await inventoryBoundary.handle(new URL(String(url)), init) ?? Response.json({}, { status: 404 });
            },
        });
        fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'execution.runs': true },
            backendEnabledByTargetKey: disabled ? { 'agent:happier.agent.claude/claude': false } : {} });
        const screen = await fixture.render(React.createElement(SessionInteractiveExecutionRunDraftView, {
            sessionId: 's1', serverId: fixture.home.id, intent: 'review', onRunStarted: vi.fn(),
            comparisonReview: { cwd: '/repo', comparison: { kind: 'workingTree' }, comparisonId: 'comparison-1',
                scopeLabel: 'Pending changes', defaultWalkthrough: true, preselectedEngineIds: preselected },
        }));
        const who = () => screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who');
        await waitForTestEvent(screen.subscribe, who, list => list !== undefined);
        if (screen.findByTestId('second-opinion.reviewers-more')) await screen.pressByTestIdAsync('second-opinion.reviewers-more');
        const targetRows = (): readonly SelectionListOption[] => who()!.props.rootStep.sections.flatMap(
            (section: SelectionListSection) => section.kind === 'static' ? section.options : []);
        await waitForTestEvent(screen.subscribe, targetRows, rows => rows.some(row => !row.disabled));
        const selected = targetRows().filter(row => who()!.props.selection.selectedIds.has(row.id));
        // A fresh review asks who should answer; explicit retry selections survive.
        expect([...new Set(selected.map(row => row.id))]).toEqual(expected
            ? [expect.stringContaining(expected)] : []);
        const claudeRows = targetRows().filter(row => backendTargetKeysMatch(row.id, { kind: 'backend', backendId: 'claude' }));
        expect(claudeRows.some(row => row.disabled === false)).toBe(!disabled);
        expect(items.slice(0, 5).map(item => item.engineId)).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'gemini']);
    });
});
