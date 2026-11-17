import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_STARTER_EXAMPLES_V1, workflowStarterRequiresSession } from '@happier-dev/protocol/workflows/builtins/examples';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Navigation is the platform boundary; the picker's own ordering is what is read.
vi.mock('@/components/appShell/workspace/destinationRoute', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { WorkflowExamplesSection } = await import('./WorkflowExamplesSection');

describe('WorkflowExamplesSection inside a Session', () => {
    it('lists the examples made for a Session first, then the general templates', async () => {
        const screen = await renderScreen(<WorkflowExamplesSection presentation="list" session={{ sessionId: 's1', machineId: 'm1' }} />);
        const keys = WORKFLOW_STARTER_EXAMPLES_V1.map((example) => example.key);
        const order = screen.findAll((node) => typeof node.props?.testID === 'string' && /^workflow-examples:[a-z-]+$/.test(node.props.testID))
            .map((node) => String(node.props.testID).slice('workflow-examples:'.length))
            .filter((key, index, all) => all.indexOf(key) === index);
        // Made for a Session: they follow one or run their steps in one. A schedule over Actions alone is general.
        const seeded = WORKFLOW_STARTER_EXAMPLES_V1.filter(workflowStarterRequiresSession).map((example) => example.key);
        expect(order.slice(0, seeded.length).sort()).toEqual([...seeded].sort());
        expect(order.slice(seeded.length)).toEqual(keys.filter((key) => !seeded.includes(key)));
    });
});
