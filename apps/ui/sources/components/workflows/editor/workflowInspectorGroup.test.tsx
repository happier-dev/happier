import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { WorkflowInspectorGroup } from './workflowInspectorGroup';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

it('reserves the effective-value summary for the closed settings group', async () => {
    const screen = await renderScreen(<WorkflowInspectorGroup
        groupId="agent" title="Agent" summary="Configured engine" attention={false} valueSet
        disclosure={new Map()} testID="settings-group"
    ><Text>Engine controls</Text></WorkflowInspectorGroup>);
    const text = () => screen.root.findAll((node) => typeof node.type === 'string' && String(node.type) === 'Text');
    expect(text().some((node) => node.children.includes('Configured engine'))).toBe(false);
    expect(text().some((node) => node.children.includes('Engine controls'))).toBe(true);
    await screen.update(<WorkflowInspectorGroup
        groupId="agent" title="Agent" summary="Configured engine" attention={false} valueSet
        disclosure={new Map([['agent', false]])} testID="settings-group"
    ><Text>Engine controls</Text></WorkflowInspectorGroup>);
    expect(text().some((node) => node.children.includes('Configured engine'))).toBe(true);
});
