/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import { computeAgentInputDefaultMaxHeight } from '../inputMaxHeight';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installAgentInputCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });
vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));
// Vitest's resolver selects the native text file; choose the real web owner exactly as Metro does.
vi.mock('./AgentInputDocumentPreviewText', async () => await import('./AgentInputDocumentPreviewText.web'));

const { AgentInputDocumentPreview } = await import('./AgentInputDocumentPreview');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let viewportHeight = 844;

beforeEach(() => {
    // RN-Web Dimensions reads the document viewport and caches it until resize.
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    window.dispatchEvent(new Event('resize'));
});

function renderPictureHost(): HTMLElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(
            <AgentInputDocumentPreview
                value="A long prompt that wraps over several lines on a phone"
                references={[]}
                placeholder="Describe the step"
                onActivate={() => {}}
            />,
        );
    });
    const host = container.querySelector<HTMLElement>('[data-composer-editor]');
    if (!host) throw new Error('document picture did not render its editor host');
    return host;
}

describe('AgentInputDocumentPreview tools (web)', () => {
    it('keeps the library and dictation in the field corner, as a Session composer does, never in the chip row', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root!.render(<AgentInputDocumentPreview value="Check the build" references={[]} placeholder="" dictation onActivate={() => {}} />);
        });
        const library = container.querySelector('[data-testid="agent-input-document-preview-prompt-library"]');
        const corner = container.querySelector('[data-testid="agent-input-document-preview-tools"]');
        const chipRow = container.querySelector('[data-testid="agent-input-document-preview-footer"]');
        expect(library).not.toBeNull();
        expect(corner?.contains(library)).toBe(true);
        expect(chipRow?.contains(library)).toBe(false);
    });
});

describe('AgentInputDocumentPreview editor box (web)', () => {
    it('grows to the height the live composer allows, from the one default-max-height owner', () => {
        viewportHeight = 844;
        window.dispatchEvent(new Event('resize'));
        const host = renderPictureHost();
        for (const height of [844, 1200]) {
            act(() => {
                viewportHeight = height;
                window.dispatchEvent(new Event('resize'));
            });
            const live = computeAgentInputDefaultMaxHeight({ platform: 'web', screenHeight: height, keyboardHeight: 0 });
            expect(host.style.maxHeight).toBe(`${live}px`);
        }
    });
});
