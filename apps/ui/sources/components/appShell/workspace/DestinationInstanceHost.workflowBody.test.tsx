import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storageStore';

// Signed-out loading bodies do not stream Markdown; this is an unused vendor/native boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in hosted Run test'); },
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module;
    const outsideNavigator = () => { throw new Error('Run body has no Expo route'); };
    return { ...module, useLocalSearchParams: outsideNavigator, usePathname: outsideNavigator,
        useRouter: outsideNavigator };
});

let previous = storage.getState();
beforeEach(() => {
    previous = storage.getState();
    storage.getState().clearProfileScope();
    storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {} });
});
afterEach(async () => { await standardCleanup(); storage.setState(previous, true); });

describe('hosted workflow Run body', () => {
    it.each([false, true])('offers Run Back with a pop-first fallback while loading (history=%s, DESIGN-11 N66)', async history => {
        const back = vi.fn();
        const replace = vi.fn();
        const screen = await renderScreen(<DestinationInstanceHost tabId="reloaded-run"
            ref={{ kind: 'workflowRun', params: { runId: 'run-one' } }} pathname="/workflows/runs/run-one"
            focused visible phone navigation={{ push: () => {}, replace, back, canGoBack: () => history }}>
            <WorkflowRunScreen />
        </DestinationInstanceHost>);
        expect(screen.findHostByTestId('workflow-run-back')).not.toBeNull();
        expect(screen.findHostByTestId('workspace-destination-header')?.findAll(node =>
            typeof node.type === 'string' && node.props.children === t('workflows.run.title')).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('workflow-run-back');
        if (history) {
            expect(back).toHaveBeenCalledOnce();
            expect(replace).not.toHaveBeenCalled();
        } else {
            expect(replace).toHaveBeenCalledWith('/workflows');
            expect(back).not.toHaveBeenCalled();
        }
    });
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
        // A cold Run reserves its page with in-place rows, not a page-sized spinner (FIN-DESIGN-REVIEW M9, lab nav-N5).
        expect(screen.findAllHostsByTestId('workflow-run-loading-rows')).toHaveLength(1);
    });
});
