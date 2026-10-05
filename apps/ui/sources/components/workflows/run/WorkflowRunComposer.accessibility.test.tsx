import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { WorkflowRunComposer, type WorkflowRunComposerProps } from './WorkflowRunComposer';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function mount(values: WorkflowRunComposerProps['values'] = {}) {
    return renderScreen(<WorkflowRunComposer inputs={[{ name: 'release', valueType: 'string', required: true }]}
        values={values} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
}

describe('workflow composer accessibility', () => {
    it('associates the required repair with the actual main input without an untouched alert', async () => {
        const screen = await mount();
        // 07 §3: untouched fields never show errors. The readiness footnote names
        // what is missing quietly; it is not an alert before any interaction.
        const reason = screen.findByTestId('workflow-run-inputs-reason');
        expect(reason?.props.accessibilityRole).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.start.addToStart');
        expect(screen.findByTestId('new-session-composer-input')?.props.accessibilityHint).toBeTruthy();
    });
    it('names a built-in input by its presentation, never by its raw key', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'request', valueType: 'string', required: true }]}
            inputPresentation={{ request: { title: 'What should the panel plan?' } }}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        const input = screen.findByTestId('new-session-composer-input');
        expect(input?.props.placeholder).toBe('What should the panel plan?');
        expect(input?.props.accessibilityLabel).toBe('What should the panel plan?');
    });
    it('closes through its presenter rather than a separate Cancel row', async () => {
        const screen = await mount();
        expect(screen.findByTestId('workflow-run-inputs-cancel')).toBeNull();
    });
    it('explains a disabled Start on the action itself', async () => {
        const screen = await mount();
        const start = screen.findByTestId('workflow-run-inputs-run');
        expect(start?.props.disabled).toBe(true);
        expect(start?.props.accessibilityHint).toBeTruthy();
    });
    it('removes the refusal from the input and Start once the value is repaired', async () => {
        const screen = await mount({ release: '1.2.0' });
        expect(screen.findByTestId('new-session-composer-input')?.props.accessibilityHint).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityHint).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-reason')).toBeNull();
    });
});
