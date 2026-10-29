import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The streaming reveal this contract exercises is host-gated: `resolveStreamingTextRevealConfig`
// takes the plain branch on reduced-motion hosts and on hosts with `hardwareConcurrency <= 4` or
// `deviceMemory <= 4`, and the reveal style is only injected while the animated branch is enabled.
// A bare 4-core CI runner (Node's built-in `navigator`) would therefore deterministically skip the
// injection under test. The capable-host stub below is installed BEFORE THE FIRST RENDER — the
// shared `useReducedMotionPreference` store latches the first value it reads and the capability
// gate reads `navigator` at render time — pinning the test to the animated branch regardless of
// the machine running the suite.
function stubCapableRevealHost(): void {
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
}

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
        stubCapableRevealHost();
        styleInjectionState.childLayoutSawStyle = [];
        installDocumentMock();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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

        // ORDERING is the contract, not the mount count. `EnrichedMarkdownTextAdapter` keys the
        // enriched child on the web runtime preload status and deliberately remounts it when the
        // preload resolves ("remount the native renderer when the web runtime becomes ready"), so
        // on a cold runtime the child's layout effect runs once per mount. The keyframes must
        // already be in the document at EVERY one of those layout effects — a `false` anywhere in
        // this list is the regression, and an empty list means the child never mounted at all.
        expect(styleInjectionState.childLayoutSawStyle).not.toHaveLength(0);
        expect(styleInjectionState.childLayoutSawStyle.filter((sawStyle) => !sawStyle)).toEqual([]);
        const revealStyle = (globalThis as { document?: Document }).document
            ?.getElementById('happier-streaming-enriched-markdown-reveal-style') as { textContent?: string } | null;
        expect(revealStyle?.textContent).toContain('@media (prefers-reduced-motion: reduce)');
        expect(revealStyle?.textContent).toContain('animation: none !important');
    });
});
