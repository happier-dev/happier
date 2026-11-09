import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { publishCodeIntelligencePaneProducer } from '@/components/workspaces/files/intelligence/codeIntelligencePaneStore';
import { useRightSidebarContentFacts } from './useRightSidebarContentFacts';

describe('right-sidebar passive content facts', () => {
    it('keeps missing resources unknown without acquiring anything', async () => {
        function Probe() {
            const facts = useRightSidebarContentFacts({ scopeId: 'no-controller' });
            return React.createElement('Facts', facts);
        }
        const screen = await renderScreen(<Probe />);
        expect(screen.findByType('Facts').props).toMatchObject({ runningServices: null, runningScripts: null, boardItems: null, problems: null, references: null });
    });

    it('observes held reference content without querying and does not render on unrelated controller changes', async () => {
        let requests = 0;
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const total = answer(1);',
            query: async () => {
                requests += 1;
                return { status: 'ok', source: 'text_matches', coverage: 'complete', hasMore: false,
                    locations: [{ path: 'target.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, lineText: 'answer()' }] };
            },
            openLocation() {},
        });
        await controller.references({ line: 0, character: 16 });
        const release = publishCodeIntelligencePaneProducer('facts-pane', {
            controller, path: 'src/current.ts', machineName: 'Machine', machineUnreachable: false,
            openReference() {}, openProblem() {}, checkProblems() {}, checkProjectProblems() {}, ask: null,
        });
        let renders = 0;
        function Probe() {
            renders += 1;
            return React.createElement('Facts', useRightSidebarContentFacts({ scopeId: 'facts-pane', runningServices: true, runningScripts: false, boardItems: null }));
        }
        const screen = await renderScreen(<Probe />);
        try {
            expect(screen.findByType('Facts').props).toMatchObject({ references: true, problems: null, runningServices: true, runningScripts: false, boardItems: null });
            expect(requests).toBe(1);
            renders = 0;
            await act(async () => { controller.inspect({ line: 0, character: 6 }); });
            expect(renders).toBe(0);
            expect(requests).toBe(1);
            await act(async () => { controller.dismiss(); });
            expect(screen.findByType('Facts').props.references).toBe(false);
        } finally {
            await screen.unmount();
            release();
            controller.dispose();
        }
    });
});
