import { describe, expect, it } from 'vitest';

import { getBindingOverridesValueRefEditorChrome } from './McpBindingOverridesEditorModal';

describe('McpBindingOverridesEditorModal chrome', () => {
    it('reuses the shared card chrome for value-ref editing', () => {
        expect(getBindingOverridesValueRefEditorChrome('env')).toEqual(
            expect.objectContaining({
                kind: 'card',
                dimensions: { size: 'lg' },
                title: expect.any(String),
            }),
        );

        expect(getBindingOverridesValueRefEditorChrome('header')).toEqual(
            expect.objectContaining({
                kind: 'card',
                dimensions: { size: 'lg' },
                title: expect.any(String),
            }),
        );
    });
});
