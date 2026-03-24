import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionMessageCardCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                if (key === 'delegation.output.title') return 'Delegation output';
                if (key === 'delegation.output.deliverablesTitle') return 'Deliverables';
                return String(key);
            },
        });
    },
});

describe('DelegateOutputMessageCard (selection)', () => {
    it('renders deliverable text as selectable', async () => {
        const { DelegateOutputMessageCard } = await import('./DelegateOutputMessageCard');

        const payload: any = {
            kind: 'delegate_output.v1',
            summary: 'Summary',
            deliverables: [{ id: 'd1', title: 'Title', details: 'Details' }],
        };

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DelegateOutputMessageCard payload={payload} />)).tree;

        const findTextNode = (text: string) => findTestInstanceByTypeContainingText(tree, 'Text', text)!;

        expect(findTextNode('Delegation output').props.selectable).toBe(true);
        expect(findTextNode('Summary').props.selectable).toBe(true);
        expect(findTextNode('Deliverables').props.selectable).toBe(true);
        expect(findTextNode('Title').props.selectable).toBe(true);
        expect(findTextNode('Details').props.selectable).toBe(true);
    });
});
