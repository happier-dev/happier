import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

import { installWorkflowRendererCommonModuleMocks } from '@/components/tools/renderers/workflow/workflowRendererTestHelpers';

installWorkflowRendererCommonModuleMocks();

let WorkflowLifecycleStatus: typeof import('./WorkflowLifecycleStatus')['WorkflowLifecycleStatus'];
let StatusPill: typeof import('@/components/ui/status/StatusPill')['StatusPill'];
beforeAll(async () => {
    ({ WorkflowLifecycleStatus } = await import('./WorkflowLifecycleStatus'));
    ({ StatusPill } = await import('@/components/ui/status/StatusPill'));
}, 300_000);

async function chromeFor(lifecycle: 'completed' | 'failed') {
    const screen = await renderScreen(<WorkflowLifecycleStatus lifecycle={lifecycle} />);
    const rendered = typeof StatusPill === 'object' && StatusPill !== null && 'type' in StatusPill ? (StatusPill as { type: unknown }).type : StatusPill;
    return screen.tree.findAll((node: ReactTestInstance) => node.type === rendered)[0]?.props.chrome;
}

describe('WorkflowLifecycleStatus', () => {
    // Healthy state is quiet (FIN-DESIGN-REVIEW M2, lab run-A_steps): only a state that needs the person
    // or failed speaks with a pill.
    it('says a healthy settled step as a quiet word and keeps the pill for a failure', async () => {
        expect(await chromeFor('completed')).toBe('plain');
        expect(await chromeFor('failed')).toBe('pill');
    });
});
