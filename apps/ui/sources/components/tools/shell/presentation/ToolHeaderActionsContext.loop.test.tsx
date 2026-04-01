import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ToolHeaderActionsContext, useToolHeaderActions } from './ToolHeaderActionsContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useToolHeaderActions (loop safety)', () => {
    it('does not trigger an update loop when the action node is referentially unstable', async () => {
        function Child() {
            // New element identity each render, but equivalent structure/props.
            useToolHeaderActions(React.createElement('Action', { style: { opacity: 1 } }, 'Hello'));
            return React.createElement('Child');
        }

        function Harness() {
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
                    <Child />
                    <ActionsSlot>{headerActions}</ActionsSlot>
                </ToolHeaderActionsContext.Provider>
            );
        }

        await expect(renderScreen(<Harness />)).resolves.toBeTruthy();
    });
});

function ActionsSlot(props: { children: React.ReactNode }) {
    return <>{props.children}</>;
}
