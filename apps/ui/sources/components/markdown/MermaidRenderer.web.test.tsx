// @vitest-environment jsdom

import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

const mermaidMocks = vi.hoisted(() => ({
    initialize: vi.fn(),
    render: vi.fn(),
}));

vi.mock('mermaid', () => ({
    default: mermaidMocks,
}));

installMarkdownCommonModuleMocks();

describe('MermaidRenderer web boundary', () => {
    beforeEach(() => {
        mermaidMocks.initialize.mockClear();
        mermaidMocks.render.mockReset();
    });

    it('dynamically renders and sanitizes Mermaid SVG', async () => {
        mermaidMocks.render.mockResolvedValue({
            svg: '<svg onclick="evil()"><script>evil()</script><text>safe</text></svg>',
        });
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(<MermaidRenderer content="graph TD; A-->B" />);
        try {
            await flushHookEffects({ cycles: 8, turns: 8 });

            const host = screen.find(node => typeof node.props.dangerouslySetInnerHTML?.__html === 'string');
            expect(host.props.dangerouslySetInnerHTML.__html).toBe('<svg><text>safe</text></svg>');
            expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B');
        } finally {
            act(() => screen.tree.unmount());
        }
    });

    it('reports terminality only after the SVG commit', async () => {
        let resolveRender!: (value: { svg: string }) => void;
        mermaidMocks.render.mockImplementation(() => new Promise((resolve) => {
            resolveRender = resolve;
        }));
        const handle = {
            complete: vi.fn(),
            dispose: vi.fn(),
        };
        const registerProducer = vi.fn(() => handle);
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer,
            }}>
                <MermaidRenderer content="graph TD; A-->B" />
            </InitialPresentationReadinessProvider>,
        );
        try {
            expect(registerProducer).toHaveBeenCalledTimes(1);
            expect(handle.complete).not.toHaveBeenCalled();

            await act(async () => {
                resolveRender({ svg: '<svg><text>settled</text></svg>' });
                await Promise.resolve();
            });

            expect(
                screen.find(node => typeof node.props.dangerouslySetInnerHTML?.__html === 'string')
                    .props.dangerouslySetInnerHTML.__html,
            ).toContain('settled');
            expect(handle.complete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => screen.tree.unmount());
        }
    });

    it('falls back to the source when Mermaid rendering fails', async () => {
        mermaidMocks.render.mockRejectedValue(new Error('invalid diagram'));
        const handle = {
            complete: vi.fn(),
            dispose: vi.fn(),
        };
        const { MermaidRenderer } = await import('./MermaidRenderer.web');
        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer: () => handle,
            }}>
                <MermaidRenderer content="not a diagram" />
            </InitialPresentationReadinessProvider>,
        );
        try {
            await flushHookEffects({ cycles: 8, turns: 8 });

            expect(screen.findByTestId('mermaid-render-error')).not.toBeNull();
            expect(screen.findByTestId('mermaid-error-source')?.props.children).toBe('not a diagram');
            expect(handle.complete).toHaveBeenCalledTimes(1);
        } finally {
            act(() => screen.tree.unmount());
        }
    });
});
