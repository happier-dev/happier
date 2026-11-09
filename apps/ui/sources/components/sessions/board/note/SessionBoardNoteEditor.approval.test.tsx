import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SessionBoardMutationV1Schema, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';

import { createActionExecutorBoundaryFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { CodeEditorHandle, CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';

const homes = createHomeGovernanceHarness();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
// CodeMirror is the platform editor boundary; the real Markdown field/card own all save wiring.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: React.forwardRef<CodeEditorHandle, CodeEditorProps>(function EmbeddedEditor(props, ref) {
        React.useImperativeHandle(ref, () => ({
            getValue: () => 'The saved note',
            flushPendingChange: async () => {},
            focus: () => {},
            revealLine: () => {},
            runCommand: () => {},
            subscribeHistory: () => () => {},
            setDecorations: () => {},
            removeDecoration: () => {},
            onDecorationPress: () => () => {},
        }), []);
        return React.createElement('EmbeddedEditor', props);
    }),
}));
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { writeApprovalRequestArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
const { isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { createSessionBoardActionAdapter } = await import('@/sync/api/session/sessionBoardActions');
const { createSessionSystemRecordRepository } = await import('@/sync/domains/sessionSystemRecords/repository');
const { createSessionBoardActionsPort, projectSessionBoard } = await import('@/sync/domains/session/board');
const { useSessionBoardController } = await import('../useSessionBoardController');
const { useSessionBoardMutationApproval } = await import('../sessionBoardMutationApproval');
const { SessionBoardNoteEditorCard } = await import('./SessionBoardNoteEditorCard');
const { resolveSessionBoardFailurePresentation } = await import('../sessionBoardFailurePresentation');

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';

describe('mounted Board note approval continuation', () => {
    beforeEach(async () => { standardCleanup(); await homes.reset(); });
    afterEach(() => standardCleanup());

    it.each(['approve', 'reject', 'cancel', 'unknown'] as const)('retires the draft only after the real %s outcome applies the saved note', async (outcome) => {
        const decision = outcome === 'unknown' ? 'approve' : outcome;
        const terminalStatus = outcome === 'unknown' ? 'outcome_unknown' : decision === 'approve' ? 'executed' : decision === 'reject' ? 'rejected' : 'canceled';
        const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://board-approval.example', accountId: 'alice' });
        const address = { serverId, sessionId: 'session-one' };
        const account = await captureLazyActionAccountContext(serverId);
        const mutations: Array<ReturnType<typeof SessionBoardMutationV1Schema.parse>> = [];
        const request: Parameters<typeof createSessionBoardActionAdapter>[0]['request'] = async (_path, init) => {
            if (init?.method !== 'PUT') return Response.json({ record: null });
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            mutations.push(mutation);
            if (mutation.operation !== 'upsert_item') throw new Error('Unexpected Board operation');
            if (outcome === 'unknown') return new Response('acknowledgement lost');
            return Response.json({ operation: 'upsert_item', itemId: mutation.itemId, outcome: 'created', itemRevision: revision, layoutRevision: revision });
        };
        const adapter = createSessionBoardActionAdapter({ scope: { serverId, accountId: 'alice' }, session: address, request,
            repository: createSessionSystemRecordRepository({ scope: { serverId, accountId: 'alice' }, request }),
            contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true }, boardEnabled: true });
        let artifactId = '';
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'session.board.item.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        // Only the Home HTTP/Artifact and credential boundaries are substituted.
        // Admission, replay, strict Board codecs, mounted custody and draft retirement stay real.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionBoardAction: adapter,
            isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input),
            approvalsCreate: async ({ request: approval }) => {
                artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(approval), JSON.stringify(approval));
                return { artifactId };
            },
            approvalsGet: async ({ artifactId: id }) => {
                const artifact = await account.fetchArtifact(id);
                const matched = artifact?.header && typeof artifact.body === 'string'
                    ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
                return matched?.family === 'built_in' ? matched.request : null;
            },
            isApprovalExecutionOriginCurrent: async ({ origin }) => {
                account.assertCurrent();
                return isApprovalExecutionOriginCurrentForAccountContext({ origin, accountServerId: serverId, accountId: account.accountId });
            },
            approvalsUpdate: async ({ artifactId: id, request: approval }) => {
                const written = await writeApprovalRequestArtifact({
                    artifactId: id, request: approval, read: id => account.fetchArtifact(id),
                    write: (basis, header, body) => account.updateArtifact(id, header, body, basis),
                });
                // Same content-free wake as the exact-Home production approval writer.
                if (written.ok) publishHomeAccountChange(serverId, [id], { changeKinds: ['artifact'] });
                return written;
            },
        }));
        const actions = createSessionBoardActionsPort({ ...address,
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context,
                authority: 'present_user', runtimeAccountId: 'alice', actionRequestId: 'note-save' }),
        });
        const snapshot = projectSessionBoard({ layout: undefined, items: new Map(),
            capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false });
        let controller!: ReturnType<typeof useSessionBoardController>;
        let approval!: ReturnType<typeof useSessionBoardMutationApproval>;
        function Board() {
            approval = useSessionBoardMutationApproval({ address, onExecuted: () => {} });
            controller = useSessionBoardController({ ...address, actions, binding: { status: 'ready', snapshot },
                requestApprovalContinuation: approval.request, approvalPending: approval.pending });
            return controller.noteDraft ? <SessionBoardNoteEditorCard sessionId={address.sessionId} {...controller.noteDraft}
                reachable actions={actions} requestApprovalContinuation={approval.request}
                onSaved={controller.onNoteSaved} onCancel={controller.closeNoteDraft} /> : null;
        }
        try {
            const screen = await renderScreen(<Board />);
            await act(async () => { await controller.run({ kind: 'add', intent: 'note' }); });
            await act(async () => { screen.changeTextByTestId('session-board-note-editor-title', 'Shipping'); });
            await screen.pressByTestIdAsync('session-board-note-editor-save');
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(screen.findHostByTestId('session-board-note-editor-notice')?.props.children)
                    .toBe(resolveSessionBoardFailurePresentation('approval_required').message);
            });
            expect(controller.noteDraft).not.toBeNull();
            expect(mutations).toHaveLength(0);
            const stored = homes.artifacts(serverId).readPlainBody(artifactId);
            expect(JSON.parse(stored)).toMatchObject({ actionId: 'session.board.item.upsert',
                actionArgs: { item: { title: 'Shipping' } } });
            await act(async () => {
                const result = await executor.execute('approval.request.decide', { artifactId, decision }, { serverId, surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice' });
                expect(result).toMatchObject({ ok: true, result: { status: terminalStatus } });
                const artifact = await account.fetchArtifact(artifactId);
                if (!artifact) throw new Error('Missing approval Artifact');
                if (typeof artifact.body !== 'string') throw new Error('Expected a plain approval Artifact body');
                expect(approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body)).toMatchObject({ family: 'built_in', request: { status: terminalStatus } });
            });
            await waitForHomeGovernance(async () => { await act(async () => {}); expect(approval.pending).toBe(false); });
            if (outcome === 'approve') {
                expect(mutations).toHaveLength(1);
                const mutation = mutations[0]!;
                expect(mutation.operation === 'upsert_item' && mutation.itemContent.t === 'plain'
                    ? SessionSurfaceItemV1Schema.parse(mutation.itemContent.v).title : null).toBe('Shipping');
                expect(controller.noteDraft, String(screen.findHostByTestId('session-board-note-editor-notice')?.props.children)).toBeNull();
                expect(controller.lastOutcome?.kind).toBe('applied');
                expect(screen.findByTestId('session-board-note-editor-title')).toBeNull();
            } else {
                expect(screen.findHostByTestId('session-board-note-editor-notice')?.props.children)
                    .toBe(outcome === 'cancel' ? undefined : resolveSessionBoardFailurePresentation(outcome === 'unknown' ? 'outcome_unknown' : 'session_board_forbidden').message);
                expect(controller.noteDraft).not.toBeNull();
                expect(screen.tree.root.findByType('EmbeddedEditor').props.value).toBe('The saved note');
                expect(mutations).toHaveLength(outcome === 'unknown' ? 1 : 0);
                if (outcome === 'unknown') expect(screen.findByTestId('session-board-note-editor-save')?.props.disabled).toBe(true);
            }
            await screen.unmount();
        } finally { account.dispose(); }
    });
});
