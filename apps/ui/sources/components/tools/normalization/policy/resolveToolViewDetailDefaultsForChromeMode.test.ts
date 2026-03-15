import { describe, expect, it } from 'vitest';

import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    resolveToolViewExpandedDetailLevelDefaultForChromeMode,
} from './resolveToolViewDetailDefaultsForChromeMode';

describe('resolveToolViewDetailDefaultsForChromeMode', () => {
    it('maps detail level default=default based on chrome mode', () => {
        expect(resolveToolViewDetailLevelDefaultForChromeMode({ chromeMode: 'cards', setting: 'default' })).toBe('summary');
        expect(resolveToolViewDetailLevelDefaultForChromeMode({ chromeMode: 'activity_feed', setting: 'default' })).toBe('compact');
    });

    it('passes through explicit detail level defaults', () => {
        expect(resolveToolViewDetailLevelDefaultForChromeMode({ chromeMode: 'cards', setting: 'full' })).toBe('full');
        expect(resolveToolViewDetailLevelDefaultForChromeMode({ chromeMode: 'activity_feed', setting: 'summary' })).toBe('summary');
    });

    it('maps expanded detail default=default based on chrome mode', () => {
        expect(resolveToolViewExpandedDetailLevelDefaultForChromeMode({ chromeMode: 'cards', setting: 'default' })).toBe('full');
        expect(resolveToolViewExpandedDetailLevelDefaultForChromeMode({ chromeMode: 'activity_feed', setting: 'default' })).toBe('summary');
    });

    it('passes through explicit expanded detail defaults', () => {
        expect(resolveToolViewExpandedDetailLevelDefaultForChromeMode({ chromeMode: 'cards', setting: 'summary' })).toBe('summary');
        expect(resolveToolViewExpandedDetailLevelDefaultForChromeMode({ chromeMode: 'activity_feed', setting: 'full' })).toBe('full');
    });
});
