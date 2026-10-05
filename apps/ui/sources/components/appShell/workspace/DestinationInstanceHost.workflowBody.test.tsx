import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';
import { DestinationInstanceHost } from './DestinationInstanceHost';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The client starts signed out: no private Run is exposed or fetched before an Account owns it.
// The real Run body, route parsing, state cards and workflow hooks remain in this test.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: createStorageStoreMock({ workflowRunInvocationsByRunId: {} }),
        useActiveServerAccountScope: () => null,
        useWorkflowRun: () => null,
        useMachine: () => null,
    });
});
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module;
    const outsideNavigator = () => { throw new Error('Run body has no Expo route'); };
    return { ...module, useLocalSearchParams: outsideNavigator, usePathname: outsideNavigator,
        useRouter: outsideNavigator };
});

afterEach(async () => { await standardCleanup(); });

describe('hosted workflow Run body', () => {
    it('keeps a valid Run loading while only the other tab has an invalid Run address', async () => {
        const screen = await renderScreen(<>
            {['', 'run-one'].map((runId, index) => <DestinationInstanceHost key={index}
                tabId={`run-tab-${index}`} ref={{ kind: 'workflowRun', params: { runId } }}
                pathname={`/workflows/runs/${runId}`} focused={index === 0} visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <WorkflowRunScreen />
            </DestinationInstanceHost>)}
        </>);
        expect(screen.findAllHostsByTestId('workflow-run-unavailable')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('workflow-run-loading')).toHaveLength(1);
    });
});
