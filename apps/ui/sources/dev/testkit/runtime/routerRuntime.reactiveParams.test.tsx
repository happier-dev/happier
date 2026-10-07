import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createExpoRouterRuntime } from './routerRuntime';

it('notifies an already mounted memo route when the Router changes its parameters', async () => {
    let currentParams = { selectedPath: '/tmp/typing' };
    const runtime = createExpoRouterRuntime({ params: () => ({ ...currentParams, tags: ['worktree'] }) });
    const Route = React.memo(function Route() {
        const params = runtime.module.useLocalSearchParams();
        return React.createElement('RouteValue', { selectedPath: params.selectedPath });
    });
    const screen = await renderScreen(React.createElement(Route));
    expect(screen.findByType('RouteValue').props.selectedPath).toBe('/tmp/typing');
    const initialSnapshot = runtime.state.params;
    await act(async () => { runtime.state.router.setParams({ selectedPath: '/tmp/typing' }); });
    expect(runtime.state.params).toBe(initialSnapshot);

    await act(async () => { runtime.state.router.setParams({ selectedPath: '/tmp/next' }); });

    expect(screen.findByType('RouteValue').props.selectedPath).toBe('/tmp/next');

    currentParams = { selectedPath: '/tmp/returned' };
    await act(async () => { runtime.resetParams(); });
    expect(screen.findByType('RouteValue').props.selectedPath).toBe('/tmp/returned');
});
