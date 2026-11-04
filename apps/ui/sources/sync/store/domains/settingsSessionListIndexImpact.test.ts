import { describe, expect, it } from 'vitest';
import { settingsParse } from '../../domains/settings/settings';
import { resolveSessionListIndexSettingsImpact } from './settingsSessionListIndexImpact';

describe('resolveSessionListIndexSettingsImpact', () => {
    it('rebuilds only for a scalar layout change, ignoring unrelated preference updates', () => {
        const initial = settingsParse({ sessionListLayoutV1: 'projects' });
        expect(resolveSessionListIndexSettingsImpact(initial, initial)).toBe(false);
        expect(resolveSessionListIndexSettingsImpact(initial, { ...initial, preferredLanguage: 'en' })).toBe(false);
        expect(resolveSessionListIndexSettingsImpact(initial, { ...initial, sessionListLayoutV1: 'recent_activity' })).toBe(true);
    });
});
