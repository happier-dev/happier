// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
    normalizePluginDeclarativeDocumentV1,
    PluginDeclarativeProjectedModelV1Schema,
    PluginDragSourceContributionV1Schema,
    PluginDropTargetContributionV1Schema,
    type JsonValue,
} from '@happier-dev/protocol';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';

import { renderScreen } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { DeclarativePluginSurface } from './DeclarativePluginSurface';
import { projectPluginUiTheme } from './pluginUiThemeProjection';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { createPluginEntityDragDropBinding, type PluginEntityDropTargetRegistration } from './entityDragDrop/pluginEntityDragDropBinding';
import { PluginEntityDragSourceView, PluginEntityDropTargetView } from './entityDragDrop/PluginEntityDragDropView';

// Native/DOM presentation is the genuine system boundary; normalization,
// public primitives, the mounted binding and shared drag runtime remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));

function dragEvent(type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: 25 }, clientY: { value: 25 } });
    return event;
}

describe('mounted declarative drag controls', () => {
    it('reaches the shared runtime through public primitives and retires without another Action effect', async () => {
        const pluginId = 'acme.review';
        const occurrenceId = 'review-7';
        const sourceIdentity = { pluginId, localId: 'card' };
        const targetIdentity = { pluginId, localId: 'tray' };
        const source = PluginDragSourceContributionV1Schema.parse({ id: 'card', title: 'Card',
            referenceSchema: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'], additionalProperties: false },
            client: { artifactId: 'ui', exportName: 'card' }, platforms: ['web'] });
        const target = PluginDropTargetContributionV1Schema.parse({ id: 'tray', title: 'Tray', acceptedKinds: ['plugin:acme.review/card'],
            actions: [{ kind: 'plugin', action: 'open' }], client: { artifactId: 'ui', exportName: 'tray' }, platforms: ['web'] });
        const normalized = normalizePluginDeclarativeDocumentV1({ pluginId, occurrenceId, actions: [],
            dragSources: [{ identity: sourceIdentity, referenceSchema: source.referenceSchema }], dropTargets: [targetIdentity],
            document: { version: 1, root: { kind: 'stack', children: [
                { kind: 'dragSource', sourceId: 'card', reference: { cardId: '42' }, children: [{ kind: 'text', text: 'Card' }] },
                { kind: 'dropTarget', targetId: 'tray', input: { lane: 'review' }, children: [{ kind: 'text', text: 'Tray' }] },
            ] } },
        });
        const model = PluginDeclarativeProjectedModelV1Schema.parse({
            identity: { pluginId, localId: 'view', qualifiedId: `${pluginId}/view`, occurrenceId }, visible: true, requiredHostMethods: [],
            declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [],
                dragSources: [{ identity: sourceIdentity, qualifiedId: `${pluginId}/card`, occurrenceId, referenceSchema: source.referenceSchema }],
                dropTargets: [{ identity: targetIdentity, qualifiedId: `${pluginId}/tray`, occurrenceId }] }, root: normalized.root,
        });
        const runtime = createEntityDragDropRuntime();
        const applied: JsonValue[] = [];
        let current = true;
        const sourceRegistration = { descriptor: source, describe: () => ({ title: 'Card' }), isCurrent: () => current };
        const targetRegistration: PluginEntityDropTargetRegistration = { descriptor: target, isCurrent: () => current,
            resolve: context => ({ status: 'allowed', effect: { actionId: 'plugin:acme.review/open',
                input: { item: context.item.kind === 'plugin' ? context.item.reference : null, destination: context.targetInput },
                preview: { verb: 'Open', target: 'Tray' } } }) };
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId, mountKey: 'declarative-view',
            scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current,
            readSource: id => id === 'card' ? sourceRegistration : null, readTarget: id => id === 'tray' ? targetRegistration : null,
            // The Action effect is the external boundary. It records acknowledged writes.
            executeAction: async (_action, input) => { applied.push(input); return { status: 'applied' }; },
        });
        const presentationHost = createPluginUiPrivatePresentationHost(undefined, {
            renderDragSource: input => <PluginEntityDragSourceView binding={binding} {...input} />,
            renderDropTarget: input => <PluginEntityDropTargetView binding={binding} {...input} />,
        });
        const environment = projectHappierUiEnvironment({ theme: projectPluginUiTheme(resolveThemeProfile({ mode: 'light', profile: null })),
            locale: 'en', direction: 'ltr', translations: {}, textScale: 1, reducedMotion: false, screenReaderEnabled: false,
            contrast: 'normal', platform: 'web', colorScheme: 'light', safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } });
        const row = document.createElement('div');
        const tray = document.createElement('div');
        tray.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} });
        const screen = await renderScreen(<PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
            <DeclarativePluginSurface pluginId={pluginId} model={model} environment={environment} interactionEnabled daemonInteractionEnabled
                dispatchAction={async () => null} actionAvailable={false} openSurface={async () => null} openSurfaceAvailable={false} authorityGeneration={1} />
        </PluginUiHostPresentationScope>, { createNodeMock: node => React.isValidElement<{ testID?: string }>(node) && node.props.testID === 'plugin-declarative-drag-source:root.children[0]' ? row
            : React.isValidElement<{ testID?: string }>(node) && node.props.testID === 'plugin-declarative-drop-target:root.children[1]' ? tray : null });
        try {
            await act(async () => { row.dispatchEvent(dragEvent('dragstart')); });
            expect(runtime.getSnapshot().item).toMatchObject({ kind: 'plugin', contribution: sourceIdentity, reference: { cardId: '42' } });
            await act(async () => { tray.dispatchEvent(dragEvent('dragover')); });
            expect(runtime.getSnapshot().admission?.status).toBe('allowed');
            expect(applied).toEqual([]);
            await act(async () => { tray.dispatchEvent(dragEvent('drop')); await Promise.resolve(); });
            expect(applied).toEqual([{ item: { cardId: '42' }, destination: { lane: 'review' } }]);
            await act(async () => { row.dispatchEvent(dragEvent('dragstart')); });
            await act(async () => { current = false; binding.dispose(); });
            await act(async () => { tray.dispatchEvent(dragEvent('drop')); await Promise.resolve(); });
            expect(applied).toEqual([{ item: { cardId: '42' }, destination: { lane: 'review' } }]);
            expect(runtime.getSnapshot().phase).toBe('idle');
        } finally {
            await act(async () => { binding.dispose(); });
            await screen.unmount();
        }
    });
});
