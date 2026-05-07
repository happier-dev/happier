import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const styleInjectionState = vi.hoisted(() => ({
    childLayoutSawStyle: [] as boolean[],
}));

installMarkdownCommonModuleMocks();

vi.mock('react-native-enriched-markdown', async () => {
    const ReactModule = await import('react');

    function EnrichedMarkdownText(props: Record<string, unknown>) {
        ReactModule.useLayoutEffect(() => {
            styleInjectionState.childLayoutSawStyle.push(
                Boolean((globalThis as { document?: Document }).document?.getElementById?.('happier-streaming-enriched-markdown-reveal-style')),
            );
        }, []);

        return ReactModule.createElement('EnrichedMarkdownText', props, props.markdown as React.ReactNode);
    }

    return {
        EnrichedMarkdownText,
        default: EnrichedMarkdownText,
    };
});

const previousDocument = globalThis.document;

function installDocumentMock() {
    const nodesById = new Map<string, Record<string, unknown>>();
    const documentMock = {
        getElementById(id: string) {
            return nodesById.get(id) ?? null;
        },
        createElement(tagName: string) {
            return {
                tagName,
                id: '',
                textContent: '',
            };
        },
        head: {
            appendChild(node: Record<string, unknown>) {
                const id = typeof node.id === 'string' ? node.id : '';
                if (id) {
                    nodesById.set(id, node);
                }
                return node;
            },
        },
    };

    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: documentMock,
    });
}

describe('MarkdownView (streaming reveal style injection)', () => {
    beforeEach(() => {
        styleInjectionState.childLayoutSawStyle = [];
        installDocumentMock();
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: previousDocument,
        });
    });

    it('injects web reveal keyframes before the enriched markdown child layout effects run', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        await renderScreen(
            <MarkdownView
                markdown="Hello streaming world"
                streamingMode="streaming"
                streamingAnimated
            />,
        );

        expect(styleInjectionState.childLayoutSawStyle).toEqual([true]);
        const revealStyle = (globalThis as { document?: Document }).document
            ?.getElementById('happier-streaming-enriched-markdown-reveal-style') as { textContent?: string } | null;
        expect(revealStyle?.textContent).toContain('@media (prefers-reduced-motion: reduce)');
        expect(revealStyle?.textContent).toContain('animation: none !important');
    });
});
