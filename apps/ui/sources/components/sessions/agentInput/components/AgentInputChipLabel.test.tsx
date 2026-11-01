import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('AgentInputChipLabel', () => {
    it('renders a positive count with the label and omits zero counts', async () => {
        const { AgentInputChipLabel } = await import('./AgentInputChipLabel');

        const screen = await renderScreen(<AgentInputChipLabel
                    label="MCP"
                    count={3}
                />);

        expect(screen.getTextContent()).toBe('MCP (3)');
        await screen.update(<AgentInputChipLabel label="MCP" count={0} />);
        expect(screen.getTextContent()).toBe('MCP');
    });
});
