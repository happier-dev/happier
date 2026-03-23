import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useWebFileDropZone } from './useWebFileDropZone.web';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useWebFileDropZone.web', () => {
    it('treats DOMStringList-like file drags as file drags', async () => {
        const onFilesDropped = vi.fn();
        const onFileDragActiveChange = vi.fn();
        let handlers!: ReturnType<typeof useWebFileDropZone>;

        function Harness() {
            handlers = useWebFileDropZone({
                enabled: true,
                onFilesDropped,
                onFileDragActiveChange,
            });
            return null;
        }

        await renderScreen(<Harness />);

        act(() => {
            handlers.onDragEnter({
                dataTransfer: {
                    types: {
                        contains: (value: string) => value === 'Files',
                    },
                },
            });
        });

        expect(onFileDragActiveChange).toHaveBeenCalledWith(true);
    });
});
