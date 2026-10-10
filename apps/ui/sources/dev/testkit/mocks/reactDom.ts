import type { ReactPortal } from 'react';
import { vi } from 'vitest';

import { requireReactDOM } from '@/utils/web/reactDomCjs';

/**
 * React Test Renderer cannot paint into a browser renderer's DOM container.
 * Keep the real portal owner and real target selection; substitute only the
 * external renderer's paint port, with typed target/key observations.
 * This does not prove DOM containment, focus or physical portal rendering.
 */
export function installReactDomPortalBoundaryForTests() {
    const reactDom = requireReactDOM() as typeof import('react-dom');
    const createPortal = vi.spyOn(reactDom, 'createPortal').mockImplementation((children) => {
        // The external renderer port returns inline nodes to Test Renderer.
        return children as ReactPortal;
    });
    return { createPortal, restore: () => createPortal.mockRestore() };
}
