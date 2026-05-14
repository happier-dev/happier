import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useWebFileDropZone } from './useWebFileDropZone';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useWebFileDropZone', () => {
    it('keeps native fallback handlers stable across unchanged parent rerenders', async () => {
        const hook = await renderHook(() => useWebFileDropZone({
            enabled: true,
            onFilesDropped: vi.fn(),
            onFileDragActiveChange: vi.fn(),
        }));

        const initialHandlers = hook.getCurrent();

        await hook.rerender();

        expect(hook.getCurrent()).toBe(initialHandlers);
    });
});
