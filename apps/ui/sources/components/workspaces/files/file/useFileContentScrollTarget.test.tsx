import * as React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';
import { CodeLinesViewCore } from '@/components/ui/code/view/CodeLinesViewCore';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { createFileViewerFindModel } from '../details/useFileViewerFind';
import { useFileContentScrollTarget } from './useFileContentScrollTarget';

installCodeViewCommonModuleMocks();

describe('file content scroll intent', () => {
    it('does not rebound to an old deep link on invalid query or close, but honors a new target', async () => {
        const text = 'first\nneedle\nlast';
        const lines = buildCodeLinesFromFile({ text });
        const model = createFileViewerFindModel(() => ({ path: 'a.ts', mode: 'file', text }));
        let scrollY = 0;
        // Native measurement/ScrollView are platform boundaries; all matching and rendering are real.
        const externalScrollView = { scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            contentRef: { current: {} as View }, offsetRef: { current: 0 } };
        function Content(props: { jumpTarget: string }) {
            const find = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
            const target = useFileContentScrollTarget(props.jumpTarget, find);
            return <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target}
                findRangesByLineId={find.lineRanges} externalScrollView={externalScrollView} />;
        }
        const screen = await renderScreen(<Content jumpTarget="f:1" />, {
            createNodeMock: () => ({ measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
        await settle();
        await act(async () => { model.open(); model.setQuery('needle'); });
        await settle();
        scrollY = 320;
        await act(async () => { model.setOptions({ matchCase: false, regex: true }); model.setQuery('['); });
        await settle();
        expect(scrollY).toBe(320);
        await act(async () => { model.close(); });
        await settle();
        expect(scrollY).toBe(320);
        await screen.update(<Content jumpTarget="f:3" />);
        await settle();
        expect(scrollY).toBe(240);
        await screen.unmount();
    });
});
