import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    applyComposerPresentationTransaction,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';

const randomUUIDSpy = vi.hoisted(() => vi.fn(() => 'scoped-authoring-composer-scope'));
const agentInputSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn<
    (params: unknown) => Promise<unknown>
>(async () => ({})));
const getSuggestionsSpy = vi.hoisted(() => vi.fn());

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDSpy(),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
}));

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
    async (importOriginal) => {
        const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedMachineRpcModuleMock({
            machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeSpy(params) as never,
        })(importOriginal);
    },
);

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'idle' as const, inputs: null }),
}));
vi.mock('@/components/plugins/actions/pluginContributedActionComposerChips', () => ({
    createPluginContributedActionComposerChips: () => [],
}));
vi.mock('@/components/plugins/surfaces/PluginContextualResourceStoreProvider', () => ({
    PluginContextualResourceStoreProvider: (props: Readonly<{ children?: React.ReactNode }>) => <>{props.children}</>,
    PluginContextualResourceState: (props: Readonly<{
        children: (snapshot: null) => React.ReactNode;
    }>) => <>{props.children(null)}</>,
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: (sessionId: string | null) => (
        sessionId === null ? null : { machineId: 'machine-1' }
    ),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (_target: unknown, enabled = true) => (enabled ? 'server-1' : null),
}));
vi.mock('@/components/autocomplete/suggestions', () => ({
    getSuggestions: (...args: unknown[]) => {
        getSuggestionsSpy(...args);
        return Promise.resolve([]);
    },
}));

describe('ScopedAuthoringComposer', () => {
    it('keeps duplicate-token ranges and staged content when its portable projection echoes back', async () => {
        const { ScopedAuthoringComposer } = await import(
            '@/components/sessions/authoring/ScopedAuthoringComposer'
        );
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
                scope={{ kind: 'session', sessionId: 's1', serverId: 'server-1' }}
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
        const { ScopedAuthoringComposer } = await import(
            '@/components/sessions/authoring/ScopedAuthoringComposer'
        );
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

        await renderScreen(<ScopedAuthoringComposer
            custody={custody}
            scope={{ kind: 'session', sessionId: 's1', serverId: 'server-1' }}
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

        expect(agentInputSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionAddress: { serverId: 'server-1', sessionId: 's1' },
        }));

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
        const { ScopedAuthoringComposer } = await import(
            '@/components/sessions/authoring/ScopedAuthoringComposer'
        );
        const custody = (await import(
            '@/components/sessions/authoring/authoringComposerCustody'
        )).createWorkflowAuthoringComposerCustody('workflow-draft-2').entryFor('neutral-step');
        const composerRef = custody.ref;
        agentInputSpy.mockClear();
        getSuggestionsSpy.mockClear();

        await renderScreen(<ScopedAuthoringComposer
            custody={custody}
            scope={{
                kind: 'machine',
                machineId: 'machine-9',
                serverId: 'server-2',
                directory: '~/code/app',
                machineHomeDir: '/Users/dev',
            }}
            document={{ text: 'Review the diff', references: [], attachments: [] }}
            onChangeDocument={() => {}}
            attachmentsEnabled
            placeholder="Describe the step"
        />);

        const composerProps = agentInputSpy.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
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
        await act(async () => { await resolve('@src', new AbortController().signal); });

        expect(getSuggestionsSpy).toHaveBeenCalledTimes(1);
        const [sessionId, query, options] = getSuggestionsSpy.mock.calls[0] as [
            unknown, string, Record<string, unknown>,
        ];
        expect(sessionId).toBeNull();
        expect(query).toBe('@src');
        expect(options.serverId).toBe('server-2');
        // The home-relative project folder is expanded by the canonical resolver,
        // so the daemon searches the project rather than its own directory.
        expect(options.workspace).toEqual({
            serverId: 'server-2',
            machineId: 'machine-9',
            rootPath: '/Users/dev/code/app',
        });
        const { resolveComposerEntityDrop } = await import('@/components/sessions/composer/composerEntityDrop');
        const scope = { serverId: 'server-2', accountId: 'account-2' };
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
