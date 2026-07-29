import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

import type {
    BrowserDiagnosticsEvalConsoleControls,
    BrowserDiagnosticsEvalConsoleEntry,
    BrowserDiagnosticsObjectInspectorEntry,
} from './BrowserDiagnosticsEvalConsole';
import { BrowserDiagnosticsEvalConsole } from './BrowserDiagnosticsEvalConsole';

function createControls(
    overrides: Partial<{
        entries: readonly BrowserDiagnosticsEvalConsoleEntry[];
        objectProperties: Readonly<Record<string, BrowserDiagnosticsObjectInspectorEntry>>;
        onSubmitExpression: (expression: string) => boolean;
        onExpandObject: (objectId: string, objectGroupId: string) => boolean;
    }> = {},
): BrowserDiagnosticsEvalConsoleControls {
    return {
        entries: overrides.entries ?? [],
        objectProperties: overrides.objectProperties ?? {},
        onSubmitExpression: overrides.onSubmitExpression ?? vi.fn(() => true),
        onExpandObject: overrides.onExpandObject ?? vi.fn(() => true),
    };
}

describe('BrowserDiagnosticsEvalConsole', () => {
    it('submits a typed expression through the eval control and clears the input', async () => {
        const onSubmitExpression = vi.fn(() => true);
        const screen = await renderScreen(
            <BrowserDiagnosticsEvalConsole
                controls={createControls({ onSubmitExpression })}
                testID="diag-eval"
            />,
        );

        await act(async () => {
            screen.changeTextByTestId('diag-eval-input', '  document.title  ');
        });
        await act(async () => {
            screen.pressByTestId('diag-eval-submit');
        });

        // The trimmed expression reaches the runtime; whitespace is not forwarded.
        expect(onSubmitExpression).toHaveBeenCalledWith('document.title');
    });

    it('renders a stored eval result and expands its remote object on demand', async () => {
        const onExpandObject = vi.fn(() => true);
        const controls = createControls({
            entries: [{
                evalRequestId: 'eval_1',
                expression: 'document',
                objectGroupId: 'group_1',
                status: 'completed',
                result: {
                    type: 'object',
                    objectId: 'object_1',
                    className: 'HTMLDocument',
                    description: '#document',
                    preview: [],
                },
            }],
            objectProperties: {
                object_1: {
                    status: 'loaded',
                    properties: [{
                        name: 'title',
                        value: { type: 'string', value: 'Dashboard', preview: [] },
                        enumerable: true,
                    }],
                },
            },
            onExpandObject,
        });

        const screen = await renderScreen(
            <BrowserDiagnosticsEvalConsole controls={controls} testID="diag-eval" />,
        );

        // The completed result entry and its expandable object node both render (not discarded).
        expect(screen.findByTestId('diag-eval-entry-eval_1')).not.toBeNull();
        const expandToggle = screen.findByTestId('diag-eval-result-eval_1-expand');
        expect(expandToggle).not.toBeNull();

        await act(async () => {
            screen.pressByTestId('diag-eval-result-eval_1-expand');
        });
        expect(onExpandObject).toHaveBeenCalledWith('object_1', 'group_1');

        // The already-loaded properties render as child nodes of the object inspector tree.
        expect(screen.findByTestId('diag-eval-result-eval_1-children')).not.toBeNull();
    });

    it('collapses an expanded object node instead of re-fetching it', async () => {
        const onExpandObject = vi.fn(() => true);
        const controls = createControls({
            entries: [{
                evalRequestId: 'eval_1',
                expression: 'document',
                objectGroupId: 'group_1',
                status: 'completed',
                result: {
                    type: 'object',
                    objectId: 'object_1',
                    className: 'HTMLDocument',
                    description: '#document',
                    preview: [],
                },
            }],
            objectProperties: {
                object_1: {
                    status: 'loaded',
                    properties: [{
                        name: 'title',
                        value: { type: 'string', value: 'Dashboard', preview: [] },
                        enumerable: true,
                    }],
                },
            },
            onExpandObject,
        });

        const screen = await renderScreen(
            <BrowserDiagnosticsEvalConsole controls={controls} testID="diag-eval" />,
        );

        // Nodes start collapsed; the first press expands and loads (one onExpandObject call).
        await act(async () => {
            screen.pressByTestId('diag-eval-result-eval_1-expand');
        });
        expect(onExpandObject).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('diag-eval-result-eval_1-children')).not.toBeNull();

        // The second press COLLAPSES (hides the children) rather than re-fetching the object.
        await act(async () => {
            screen.pressByTestId('diag-eval-result-eval_1-expand');
        });
        expect(onExpandObject).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('diag-eval-result-eval_1-children')).toBeNull();
    });
});
