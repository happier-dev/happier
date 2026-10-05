import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { ShareSheet } from './ShareSheet';
import { createDocumentShareAdapter } from './documents/documentShareAdapter';
import type { ShareSheetActions, ShareSheetModel } from './shareSheetTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized renderer is a third-party boundary; all sharing/list logic stays real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true }).module.LegendList };
});

const noop = () => {};
const actions: ShareSheetActions = {
    setQuery: noop, retryDirectory: noop, loadMore: noop, addPrincipal: noop, retryMutation: noop,
    setAccessLevel: noop, requestRemove: noop, confirmRemove: noop, cancelRemove: noop, explain: noop,
};
const model: ShareSheetModel = {
    revision: 0, editable: true, stale: false, owner: null, grants: [],
    directory: { query: '', sections: [] },
};
const adapter = createDocumentShareAdapter({ artifactId: 'wf-1', kind: 'workflow-definition.v1',
    grants: [], loading: false, readOnly: false, retryContent: noop });

describe('ShareSheet full presentation', () => {
    it('keeps the level explanation outside the selectable roster and offers a direct completion action', async () => {
        const close = vi.fn();
        const sendCopy = vi.fn();
        const screen = await renderScreen(<ShareSheet model={model} actions={actions}
            adapter={{ ...adapter, sendCopy }} presentation="full" onRequestClose={close} testID="document-share-editor" />);

        expect(screen.findByTestId('document-share-help')).not.toBeNull();
        expect(screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.includes(':option:level-help:'))).toEqual([]);
        expect(screen.findByTestId('document-share-editor:list:document-share:option:send-copy')).toBeNull();
        await screen.pressByTestIdAsync('document-share-send-copy');
        expect(sendCopy).toHaveBeenCalledOnce();
        await screen.pressByTestIdAsync('document-share-done');
        expect(close).toHaveBeenCalledOnce();
    });

    it('keeps known Team and Team-group browse rows available while the directories load and after an empty response', async () => {
        const directories = ['team', 'group'] as const;
        const loadingModel: ShareSheetModel = { ...model, directory: { query: '', sections: directories.map(kind => ({
            kind, title: kind === 'team' ? 'Teams' : 'Groups', candidates: [], status: 'loading',
            cursor: null, hasMore: false, loadingMore: false,
        })) } };
        const screen = await renderScreen(<ShareSheet model={loadingModel} actions={actions}
            adapter={adapter} presentation="full" testID="document-share-editor" />);
        await flushHookEffects();
        for (const kind of directories) expect(screen.findByTestId(`document-share-browse:${kind}`)).not.toBeNull();
        await screen.update(<ShareSheet model={{ ...loadingModel, revision: 1, directory: { query: '',
            sections: loadingModel.directory.sections.map(source => ({ ...source, status: 'idle' })) } }}
            actions={actions} adapter={adapter} presentation="full" testID="document-share-editor" />);
        await flushHookEffects();
        for (const kind of directories) expect(screen.findByTestId(`document-share-browse:${kind}`)).not.toBeNull();
    });
});
