import { describe, expect, it } from 'vitest';

import { en as defaultEn } from './_default';
import { en as runtimeEn } from './translations/en';

describe('text/_default', () => {
    it('re-exports the runtime english translation object', () => {
        expect(defaultEn).toBe(runtimeEn);
    });
});
