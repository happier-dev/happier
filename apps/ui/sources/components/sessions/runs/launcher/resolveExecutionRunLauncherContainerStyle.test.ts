import { describe, expect, it } from 'vitest';

import { resolveExecutionRunLauncherContainerStyle } from './resolveExecutionRunLauncherContainerStyle';

describe('resolveExecutionRunLauncherContainerStyle', () => {
    it('adds details-pane padding for panel presentation', () => {
        expect(resolveExecutionRunLauncherContainerStyle('panel')).toMatchObject({
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 16,
        });
    });
});
