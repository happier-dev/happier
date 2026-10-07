import { describe, expect, it } from 'vitest';
import { localSettingsParse } from '../../localSettings';

describe('device-local widget preferences', () => {
    it('does not retain obsolete instance-specific viewer selections', () => {
        const selection = { service: { pluginId: 'com.acme.metrics', localId: 'cloud' }, accountId: 'viewer-account' };
        expect(localSettingsParse({ widgetViewerInputSelectionsV1: { first: selection } })).not.toHaveProperty('widgetViewerInputSelectionsV1');
    });
    it('recovers each malformed choice independently while retaining the other saved choices', () => {
        expect(localSettingsParse({})).toMatchObject({ widgetFrameStyleHome: 'card', widgetFrameStyleBoard: 'card', widgetFrameStyleCompanion: 'plain' });
        expect(localSettingsParse({ widgetFrameStyleHome: 'plain', widgetFrameStyleBoard: 'wrong', widgetFrameStyleCompanion: 'card' })).toMatchObject({ widgetFrameStyleHome: 'plain', widgetFrameStyleBoard: 'card', widgetFrameStyleCompanion: 'card' });
    });
});
