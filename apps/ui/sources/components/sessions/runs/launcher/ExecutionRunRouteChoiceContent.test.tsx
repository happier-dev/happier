import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ExecutionRunRouteChoiceContent } from './ExecutionRunRouteChoiceContent';

describe('ExecutionRunRouteChoiceContent', () => {
    it('follows the session by default and reveals the Run\'s own model choice only when asked', async () => {
        const onInherit = vi.fn();
        const screen = await renderScreen(<ExecutionRunRouteChoiceContent inherits canInherit inheritDetail="Main gateway · fable-5.1"
            onInherit={onInherit} chooseContent={<View testID="run-model-field" />} />);
        expect(screen.findByTestId('run-model-field')).toBeNull();
        await screen.pressByTestIdAsync('execution-run-route-choice.choose');
        expect(screen.findByTestId('run-model-field')).not.toBeNull();
        // Opening the choice changed nothing; going back to the session does not rewrite an inheriting draft.
        await screen.pressByTestIdAsync('execution-run-route-choice.inherit');
        expect(screen.findByTestId('run-model-field')).toBeNull();
        expect(onInherit).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('drops the Run\'s own choice when the person returns to the session route', async () => {
        const onInherit = vi.fn();
        const screen = await renderScreen(<ExecutionRunRouteChoiceContent inherits={false} canInherit inheritDetail={null}
            onInherit={onInherit} chooseContent={<View testID="run-model-field" />} />);
        expect(screen.findByTestId('run-model-field')).not.toBeNull();
        await screen.pressByTestIdAsync('execution-run-route-choice.inherit');
        expect(onInherit).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});
