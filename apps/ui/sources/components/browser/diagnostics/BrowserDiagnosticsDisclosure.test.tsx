import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { BrowserDiagnosticsEvalConsole } from './BrowserDiagnosticsEvalConsole';
import { DiagnosticsRow } from './BrowserDiagnosticsFamilyPanel';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Absolute resolution bypasses the Node test shim's react-native-web package proxy.
// The real installed mapper drops accessibilityState.expanded, unlike the native renderer.
const require = getVitestNodeBuiltin<typeof import('node:module')>('node:module').createRequire(import.meta.url);
const createDOMProps: (tag: string, props: Record<string, unknown>) => Record<string, unknown> =
    require(require.resolve('react-native-web/dist/cjs/modules/createDOMProps'));
const { renderToStaticMarkup }: typeof import('react-dom/server') = require('react-dom/server');

describe('Browser diagnostics web disclosure semantics', () => {
    it.each(['family', 'eval'] as const)('announces collapsed and expanded %s rows on the web', async kind => {
        const id = kind === 'family' ? 'row' : 'eval-result-one-expand';
        const screen = await renderScreen(kind === 'family'
            ? <DiagnosticsRow testID="row" subject="Request" renderDetail={() => <></>} />
            : <BrowserDiagnosticsEvalConsole testID="eval" controls={{
                entries: [{ evalRequestId: 'one', expression: 'object', objectGroupId: 'group', status: 'completed',
                    result: { type: 'object', objectId: 'object', preview: [] } }],
                objectProperties: {}, onSubmitExpression: () => true, onExpandObject: () => true, onCancelEval: () => {},
            }} />);
        const markup = () => {
            const props = createDOMProps('button', screen.findHostByTestId(id)!.props);
            return renderToStaticMarkup(React.createElement('button', props));
        };
        expect(markup()).toContain('aria-expanded="false"');
        await act(async () => { screen.pressByTestId(id); });
        expect(markup()).toContain('aria-expanded="true"');
        await act(async () => { screen.pressByTestId(id); });
        expect(markup()).toContain('aria-expanded="false"');
    });
});
