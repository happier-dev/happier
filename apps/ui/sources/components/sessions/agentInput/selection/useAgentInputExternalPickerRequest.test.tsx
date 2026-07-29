import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { useAgentInputExternalPickerRequest } from './useAgentInputExternalPickerRequest';

describe('useAgentInputExternalPickerRequest', () => {
    it('opens only when a non-empty request key changes after mount', async () => {
        const open = vi.fn();
        function Harness(props: { requestKey: string | null }) {
            useAgentInputExternalPickerRequest({ requestKey: props.requestKey, open });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness requestKey={null} />);
        await screen.update(<Harness requestKey="1" />);
        await act(async () => {});
        expect(open).toHaveBeenCalledTimes(1);
        await screen.update(<Harness requestKey="1" />);
        expect(open).toHaveBeenCalledTimes(1);
    });
});
