import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ToolHeaderActionsContext, useToolHeaderActions } from './ToolHeaderActionsContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useToolHeaderActions (loop safety)', () => {
    it('publishes, updates and clears referentially unstable actions without an update loop', async () => {
        function Child({ label }: { label: string }) {
            // New element identity each render, but equivalent structure/props.
            useToolHeaderActions(React.createElement('Action', { style: { opacity: 1 } }, label));
            return React.createElement('Child');
        }

        function Harness({ label, showChild = true }: { label: string; showChild?: boolean }) {
            const [headerActions, setHeaderActionsState] = React.useState<React.ReactNode | null>(null);
            const callCountRef = React.useRef(0);
            const setHeaderActions = React.useCallback((node: React.ReactNode | null) => {
                callCountRef.current += 1;
                if (callCountRef.current > 25) {
                    throw new Error('Loop detected: setHeaderActions invoked too many times');
                }
                setHeaderActionsState(node);
            }, []);
            return (
                <ToolHeaderActionsContext.Provider value={{ setHeaderActions }}>
                    {showChild ? <Child label={label} /> : null}
                    <ActionsSlot>{headerActions}</ActionsSlot>
                </ToolHeaderActionsContext.Provider>
            );
        }

        const screen = await renderScreen(<Harness label="Hello" />);
        expect(screen.findByType('Action').props.children).toBe('Hello');

        await screen.update(<Harness label="Goodbye" />);
        expect(screen.findAllByType('Action')).toHaveLength(1);
        expect(screen.findByType('Action').props.children).toBe('Goodbye');

        await screen.update(<Harness label="Goodbye" showChild={false} />);
        expect(screen.findAllByType('Action')).toHaveLength(0);
        await screen.unmount();
    });
});

function ActionsSlot(props: { children: React.ReactNode }) {
    return <>{props.children}</>;
}
