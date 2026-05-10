import { describe, expect, it } from 'vitest';

import { readSessionDisplayTitleField } from './selectors';

describe('session state selectors', () => {
    it('reads display.title from canonical summary metadata', () => {
        expect(readSessionDisplayTitleField({
            metadata: {
                summary: {
                    text: '  Display title  ',
                    updatedAt: 123,
                },
            },
        })).toEqual({
            value: 'Display title',
            updatedAt: 123,
        });
    });

    it('reads display.title from renderable summaryText metadata when canonical summary is absent', () => {
        expect(readSessionDisplayTitleField({
            metadata: {
                summaryText: '  Cached renderable title  ',
            },
        })).toEqual({
            value: 'Cached renderable title',
            updatedAt: null,
        });
    });
});
