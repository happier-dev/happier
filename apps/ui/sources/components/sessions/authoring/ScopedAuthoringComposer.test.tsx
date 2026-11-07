import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { DaemonWorkspaceFileListResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const machineCalls: Array<Readonly<{ method: string; input: unknown; targetId: string }>> = [];
installAgentInputCommonModuleMocks();
// File reads use the authenticated Action HTTP boundary; the composer, policy,
// requester custody and materialization below it remain real.
const workspaceFiles = await createExternalActionAccountHttpBoundary({
    serverUrl: 'https://session-pane.test', serverIdentityId: 'srv_session_pane',
    accountId: 'account-a', machineId: 'machine-9', tokenEpoch: 0,
    actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles,
    execute: (input, context) => {
        machineCalls.push({ method: getActionSpec(FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles).bindings!.rpcMethod!,
            input, targetId: context.target.machineId });
        return DaemonWorkspaceFileListResponseSchema.parse({ ok: true, paths: ['src/index.ts'], truncated: false });
    },
});
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness({
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    request: async (url, init) => await workspaceFiles.handle(new URL(String(url)), init)
        ?? createPlainMachineReadHttpResponseFixture(new URL(String(url)).pathname, init, 'account-a'),
    rpc: async (method, input, targetId) => {
    machineCalls.push({ method, input, targetId });
    return {};
} });
const { storage } = await import('@/sync/domains/state/storageStore');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { ScopedAuthoringComposer } = await import('@/components/sessions/authoring/ScopedAuthoringComposer');
const { applyComposerPresentationTransaction, readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
async function renderScreen(element: React.ReactElement) {
    // Match the plain Machine served by the HTTP boundary in Sync's hydrated projection too.
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-9', storageMode: 'plain' })]);
    const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
    observeMachinePresenceForTest({ serverId: runtime.serverId, accountId: 'account-a' }, ['machine-9']);
    return renderPanelScreen(element, { wrapper: runtime.Wrapper });
}

describe('ScopedAuthoringComposer', () => {
    it('offers host-owned references without a Machine or a daemon reference catalog', async () => {
        const custody = (await import('@/components/sessions/authoring/authoringComposerCustody'))
            .createWorkflowAuthoringComposerCustody('workflow-local-results').entryFor('review');
        const result = { kind: 'composerReference' as const, key: 'prior', text: '@analysis',
            group: 'Step results', structuredInput: { kind: 'happier.workflowInput', ref: 'workflowInput:0', label: 'Analysis' } };
        const screen = await renderScreen(<ScopedAuthoringComposer custody={custody}
            scope={{ kind: 'machine', machineId: null, serverId: runtime.serverId }}
            document={{ text: 'Review', references: [], attachments: [] }} attachmentsEnabled
            placeholder="Describe the step" additionalSuggestions={() => [result]} />);
        const resolve = screen.findByType<typeof AgentInput>(AgentInput).props.autocompleteSuggestions;
        if (!resolve) throw new Error('Expected the real composer suggestion entry point');
        await expect(resolve('@', new AbortController().signal)).resolves.toContainEqual(result);
    });
    it('keeps duplicate-token ranges and staged content when its portable projection echoes back', async () => {
        const custody = (await import(
            '@/components/sessions/authoring/authoringComposerCustody'
        )).createWorkflowAuthoringComposerCustody('workflow-draft-echo').entryFor('review-step');
        const composerRef = custody.ref;
        const stagedAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            content: {
                kind: 'stagedMedia' as const,
                handle: {
                    v: 1 as const,
                    id: 'stage-42',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    owner: { pluginId: 'acme.issues', localId: 'issue' },
                    mediaKind: 'image' as const,
                    mimeType: 'image/png',
                    name: 'issue-42.png',
                    sizeBytes: 12,
                    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                },
            },
        };
        const published = vi.fn();
        function ControlledComposer() {
            const [document, setDocument] = React.useState({
                text: 'Compare @issue with @issue',
                references: [] as ReadonlyArray<Record<string, unknown>>,
                attachments: [stagedAttachment],
            });
            return <ScopedAuthoringComposer
                custody={custody}
                scope={{ kind: 'session', sessionId: 's1', serverId: runtime.serverId }}
                document={document as never}
                onChangeDocument={(next) => {
                    published(next);
                    setDocument(next as never);
                }}
                attachmentsEnabled
                placeholder="Describe the step"
            />;
        }

        await renderScreen(<ControlledComposer />);
        const initial = readComposerPresentationSnapshot(composerRef);
        if (!initial) throw new Error('Expected mounted Workflow composer target');
        const secondStart = 'Compare @issue with '.length;

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: composerRef,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            label: 'Issue #42',
                            start: secondStart,
                            end: secondStart + '@issue'.length,
                        },
                    }],
                },
            })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });

        expect(published).toHaveBeenLastCalledWith({
            text: 'Compare @issue with @issue',
            references: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                token: '@issue',
                label: 'Issue #42',
            }],
            attachments: [{
                v: 1,
                instanceId: 'attachment-staged',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: 'issue-42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            }],
        });
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            references: [{ start: secondStart, end: secondStart + '@issue'.length }],
            attachments: [{ content: stagedAttachment.content }],
        });
    });

    it('round-trips and removes portable Workflow references and attachments through the shared composer owner', async () => {
        const onChangeDocument = vi.fn();
        const custody = (await import(
            '@/components/sessions/authoring/authoringComposerCustody'
        )).createWorkflowAuthoringComposerCustody('workflow-draft-1').entryFor('review-step');
        const composerRef = custody.ref;
        const reference = {
            kind: 'partner.reference',
            ref: 'partner:issue-42',
            token: '@issue',
            label: 'Issue #42',
        };
        const attachment = {
            v: 1 as const,
            instanceId: 'attachment-1',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };

        const screen = await renderScreen(<ScopedAuthoringComposer
            custody={custody}
            scope={{ kind: 'session', sessionId: 's1', serverId: runtime.serverId }}
            document={{
                text: 'Review @issue',
                references: [reference],
                attachments: [attachment],
            }}
            onChangeDocument={onChangeDocument}
            attachmentsEnabled
            placeholder="Describe the step"
        />);

        const initial = readComposerPresentationSnapshot(composerRef);
        expect(initial).toMatchObject({
            ref: composerRef,
            text: 'Review @issue',
            references: [{ ...reference, start: 7, end: 13 }],
            attachments: [attachment],
            capabilities: {
                text: true,
                references: true,
                attachments: true,
                submit: false,
            },
        });
        if (!initial) throw new Error('expected mounted Workflow composer target');

        expect(screen.findByType<typeof AgentInput>(AgentInput).props.sessionAddress).toEqual({ serverId: runtime.serverId, sessionId: 's1' });

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: composerRef,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [
                        {
                            kind: 'reference.remove',
                            reference: { ref: reference.ref, start: 7, end: 13 },
                        },
                        { kind: 'attachment.remove', instanceId: attachment.instanceId },
                    ],
                },
            })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });

        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text: 'Review @issue',
            references: [],
            attachments: [],
        });
        expect(onChangeDocument).toHaveBeenLastCalledWith({
            text: 'Review @issue',
            references: [],
            attachments: [],
        });
    });

    /**
     * An ordinary Workflow step has no Session, but it does have the exact
     * Machine and project folder the workflow already selected. That scope is
     * enough for the canonical suggestion owner, so the step keeps mention,
     * reference and file authoring instead of degrading to a plain text box —
     * and it must not address a Session it does not have.
     */
    it('addresses a Machine-scoped document by its selected Machine and project folder', async () => {
        const custody = (await import(
            '@/components/sessions/authoring/authoringComposerCustody'
        )).createWorkflowAuthoringComposerCustody('workflow-draft-2').entryFor('neutral-step');
        const composerRef = custody.ref;
        machineCalls.length = 0;

        const screen = await renderScreen(<ScopedAuthoringComposer
            custody={custody}
            scope={{
                kind: 'machine',
                machineId: 'machine-9',
                serverId: runtime.serverId,
                directory: '~/code/app',
                machineHomeDir: '/Users/dev',
            }}
            document={{ text: 'Review the diff', references: [], attachments: [] }}
            onChangeDocument={() => {}}
            attachmentsEnabled
            placeholder="Describe the step"
        />);

        const composerProps = screen.findByType<typeof AgentInput>(AgentInput).props;
        expect(composerProps).toBeDefined();
        // No Session is fabricated for a portable document.
        expect(composerProps?.sessionId).toBeUndefined();
        expect(composerProps?.sessionAddress).toBeNull();
        expect(composerProps?.autocompleteKinds).toContain('file');
        expect(composerProps?.autocompleteKinds).toContain('composerReference');
        // Without a submit owner the composer is authoring-only: no substitute
        // no-op submission reaches AgentInput (its absence disables every submit path).
        expect(composerProps !== undefined && 'onSend' in composerProps && composerProps.onSend !== undefined).toBe(false);

        const resolve = composerProps?.autocompleteSuggestions as
            (query: string, signal: AbortSignal) => Promise<unknown>;
        let suggestions: unknown;
        await act(async () => { suggestions = await resolve('@src', new AbortController().signal); });
        expect(suggestions).toEqual(expect.arrayContaining([expect.objectContaining({
            kind: 'file', structuredInput: expect.objectContaining({ ref: 'file:src/index.ts' }),
        })]));
        expect(machineCalls).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: 'machine-9', method: RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
            input: expect.objectContaining({ rootPath: '/Users/dev/code/app' }),
        })]));
        // The home-relative project folder is expanded by the canonical resolver,
        // so the daemon searches the project rather than its own directory.
        expect(composerProps.composerFileScope).toEqual({
            serverId: runtime.serverId,
            machineId: 'machine-9',
            rootPath: '/Users/dev/code/app',
        });
        const { resolveComposerEntityDrop } = await import('@/components/sessions/composer/composerEntityDrop');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const result = resolveComposerEntityDrop({
            kind: 'repository-file', scope, machineId: 'machine-9', path: '/Users/dev/code/app/src/index.ts',
        }, {
            scope, ref: composerRef, snapshot: readComposerPresentationSnapshot(composerRef),
            sessions: [], workspace: composerProps?.composerFileScope as import('@/sync/domains/input/suggestionFile').FileSuggestionScope | null,
            preview: { verb: 'Reference', target: 'Workflow' }, reason: code => code,
        });
        expect(result.status).toBe('allowed');
    });
});
