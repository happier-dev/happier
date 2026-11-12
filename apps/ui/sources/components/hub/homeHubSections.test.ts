import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { homeHubSectionTitle } from './homeHubSections';
import type { HomeHubSection } from './layout/homeHubLayout';

const INSTANCE_ID = 'c340a13c-246b-4df2-bf6d-0f2e1a1b9c11';

function widgetSection(instance: Partial<Pick<WidgetInstanceV1, 'displayName' | 'definition'>>): HomeHubSection<never> {
    return { kind: 'widget', id: INSTANCE_ID, hideable: true, hidden: false,
        instance: { v: 1, id: INSTANCE_ID, definition: { kind: 'installed', surface: { pluginId: 'gone.plugin', localId: 'card' } }, bindings: {}, ...instance } } as unknown as HomeHubSection<never>;
}

describe('homeHubSectionTitle', () => {
    it('names an absent plugin as unavailable, never by its instance id', () => {
        expect(homeHubSectionTitle(widgetSection({}))).toBe(t('sessionBoard.item.pluginUnavailable.title'));
        expect(homeHubSectionTitle(widgetSection({}))).not.toContain(INSTANCE_ID);
    });
    it('keeps an unreadable authored definition neutral', () => {
        expect(homeHubSectionTitle(widgetSection({ definition: { kind: 'artifact', artifactId: 'unreadable-widget' } })))
            .toBe(t('composerReferences.kindWidget'));
    });
    it('names a widget its own name when it has one', () => {
        expect(homeHubSectionTitle(widgetSection({ displayName: 'My counter' }))).toBe('My counter');
    });
});
