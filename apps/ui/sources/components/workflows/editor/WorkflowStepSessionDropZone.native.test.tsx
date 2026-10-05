import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { bindWorkflowSessionConversation, resolveWorkflowSessionBinding } from '@/sync/domains/workflows/workflowAuthoringSessionBinding';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowConversationBindInputV1Schema } from '@happier-dev/protocol';
import { WorkflowStepSessionDropZone, type WorkflowSessionDrop } from './WorkflowStepSessionDropZone';

installPanelCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { View: 'View' });
} });

describe('native Workflow Session target geometry', () => {
    it('refreshes hover and does not bind the former step after window coordinates change without child layout', async () => {
        const runtime = useEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        const original = createWorkflowEditorDraft({ draftId: 'draft', name: 'Review', blocks: [{ kind: 'step', id: 'review',
            document: { text: 'Preserve prompt', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
        let draft = original;
        const context = () => ({ scope, draft, editable: true, whereMachineId: 'machine',
            candidates: [{ sessionId: 'existing', machineId: 'machine', label: 'Existing Session' }] });
        const sessionDrop: WorkflowSessionDrop = {
            scope,
            resolve: (stepId, item) => {
                if (item.kind !== 'session') throw new Error('Expected Session source');
                const input = { scope: item.scope, draftId: draft.draftId, stepId, address: item.address };
                const admission = resolveWorkflowSessionBinding(context(), input);
                return admission.status === 'refused' ? { status: 'refused', reason: { code: admission.reason, message: admission.reason } }
                    : { status: 'allowed', effect: { actionId: 'workflow.authoring.conversation.bind', input, preview: { verb: 'Bind', target: 'Review' } } };
            },
            execute: async effect => {
                const result = bindWorkflowSessionConversation(context(), WorkflowConversationBindInputV1Schema.parse(effect.input));
                if (result.status === 'applied') draft = result.draft;
                return result.status === 'refused' ? { status: 'refused', reason: { code: result.reason, message: result.reason } } : { status: 'applied' };
            },
            bind: async () => { throw new Error('Geometry journey must use the mounted target'); },
        };
        const retire = runtime.registerSource({ id: 'workflow-geometry-source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'existing' } }) });
        let y = 0;
        const screen = await renderScreen(<WorkflowStepSessionDropZone stepId="review" label="Review" sessionDrop={sessionDrop} testID="step-drop">
            <React.Fragment />
        </WorkflowStepSessionDropZone>, { createNodeMock: element => typeof element.props === 'object' && element.props !== null
            && 'testID' in element.props && element.props.testID === 'step-drop'
            ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, y, 100, 100) }
            : null });
        await act(async () => { screen.findByTestId('step-drop')?.props.onLayout(); });
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { carry = runtime.begin('workflow-geometry-source')!; });
        await act(async () => { carry.move({ x: 50, y: 50 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        y = 200;
        await act(async () => { await runtime.refreshMeasurements(); });
        expect(runtime.getSnapshot().targetId).toBeNull();
        await act(async () => { carry.move({ x: 50, y: 250 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        y = 400;
        await act(async () => { expect(await carry.release()).toBeNull(); });
        expect(draft).toBe(original);
        let current!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { current = runtime.begin('workflow-geometry-source')!; });
        await act(async () => { current.move({ x: 50, y: 450 }); expect(await current.release()).toEqual({ status: 'applied' }); });
        expect(draft.blocks[0]).toMatchObject({ execution: { conversation: { kind: 'existing_session', sessionId: 'existing', machineId: 'machine' } } });
        await act(async () => { retire(); });
    });
});
