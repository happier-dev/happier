/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { TelemetryKeyFlowConfigV1Schema } from '@happier-dev/plugin-sdk/database';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { renderSurface } from '../../../../../../packages/plugins/machine-services/src/ui/healthSetup';
import {
    PluginUiPresentationHostProviderInternal,
} from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import {
    createHostApiStub,
    createSurfaceContext,
} from '../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: <T,>(values: Readonly<{ web?: T; default?: T; native?: T; ios?: T; android?: T }>) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: () => null }));
vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({ CodeBlockView: () => null }));

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

vi.mock('@/utils/web/reactDomCjs', async () => {
    const ReactDOM = await import('react-dom');
    return { requireReactDOM: () => ReactDOM };
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));


it('keeps the trace check window entered while the statistic menu closes and saves both edits', async () => {
    const { BaseModal } = await import('@/modal/components/BaseModal');
    const context = createSurfaceContext();
    const presentation = createPluginUiPrivatePresentationHost(undefined);
    const subject = { kind: 'environment', environmentId: 'env-prod' } as const;
    const kind = { pluginId: 'happier.telemetry', localId: 'key-flow' };
    const traceSeed = {
        environmentId: subject.environmentId, serviceName: 'DBW R4 control/R4 control',
        measure: { kind: 'route', routes: [{ method: 'GET', route: '/checkout' }], statistic: 'p95' },
    };
    const settled: unknown[] = [];
    const configSchema: JsonValue = JSON.parse(JSON.stringify(TelemetryKeyFlowConfigV1Schema.jsonSchema));
    const hostApi = createHostApiStub(context, {
        executeAction: async action => typeof action === 'object' && action.localId === 'health/setup'
            ? { mode: 'preview', destinationSelectionContext: { serverId: 'home', machineId: 'watcher' },
                sourceConfig: { v: 1, subject, alerts: { channels: [], phases: ['open', 'recovered'] } } }
            : [{ pluginId: kind.pluginId, id: kind.localId, title: 'Key flow', action: 'health/key-flow', configSchema }],
        settleEphemeralInput: async settlement => { settled.push(settlement); },
    });
    const shell = document.body.appendChild(document.createElement('div'));
    const root = createRoot(shell);
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        ({ x: 100, y: 100, width: 180, height: 40, top: 100, left: 100, right: 280, bottom: 140, toJSON: () => ({}) }));
    const element = <T extends HTMLElement>(selector: string): T => {
        const found = document.querySelector<T>(selector);
        if (!found) throw new Error('Missing ' + selector);
        return found;
    };
    const type = async (label: string, value: string) => {
        const field = element<HTMLInputElement>('input[aria-label="' + label + '"]');
        await act(async () => { field.focus(); });
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
        await act(async () => {
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const signal = new AbortController().signal;
    try {
        await act(async () => root.render(
            <BaseModal visible closeOnBackdrop={false}>
                <PluginUiPresentationHostProviderInternal host={presentation}>
                    {renderSurface({ plugin: { id: 'happier.machine-services', version: '0.0.0' },
                        surface: context, hostApi, signal, launchInput: { initialInput: {
                            v: 1, subject, newContributedCheck: { kind, config: traceSeed },
                        } } })}
                </PluginUiPresentationHostProviderInternal>
            </BaseModal>,
        ));
        const trigger = await vi.waitFor(() => element<HTMLElement>('[aria-label="Statistic: P95"]'));
        await act(async () => { trigger.click(); });
        const rate = await vi.waitFor(() => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('[role=menuitemradio]'))
                .find(item => item.textContent?.includes('Error rate'));
            if (!row) throw new Error('Error rate option was not mounted');
            return row;
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const callbacks: FrameRequestCallback[] = [];
        const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => callbacks.push(callback));
        try {
            await act(async () => { rate.click(); });
            expect(document.querySelector('[role=menuitemradio]')).toBeNull();
            await type('Window ms', '600000');
            expect(trigger.getAttribute('aria-label')).toBe('Statistic: P95');
            expect(element<HTMLInputElement>('input[aria-label="Window ms"]').value).toBe('600000');
            await act(async () => { callbacks.splice(0).forEach(callback => callback(performance.now())); });
        } finally {
            frame.mockRestore();
            vi.useRealTimers();
        }
        expect(trigger.getAttribute('aria-label')).toBe('Statistic: Error rate');
        await type('Value', '0.25');
        const add = element<HTMLButtonElement>('[data-testid=health-setup-add]');
        expect(add.disabled).toBe(false);
        await act(async () => { add.click(); });
        expect(settled).toEqual([expect.objectContaining({
            kind: 'completed',
            input: expect.objectContaining({
                checks: [expect.objectContaining({ config: {
                    ...traceSeed, measure: { ...traceSeed.measure, statistic: 'errorRate' },
                    windowMs: 600_000, threshold: { operator: 'above', value: 0.25 },
                } })],
            }),
        })]);
    } finally {
        await act(async () => root.unmount());
        shell.remove();
        rect.mockRestore();
    }
});
