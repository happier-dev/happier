import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { WidgetAreaPresetStateV1Schema, type WidgetAreaPresetStateV1 } from '@happier-dev/protocol/widgets';

import { renderScreen } from '@/dev/testkit';

import { WidgetAreaPresetLine } from './WidgetAreaPresetLine';
import { t } from '@/text';

const surface = { serverId: 'home', accountId: 'one', owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main', layoutId: 'overview' } };
const widget = (id: string, displayName: string) => ({ kind: 'widget' as const,
    instance: { v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'usage_daily' as const }, bindings: {}, displayName } });

describe('an edited preset\'s line', () => {
    it('names an unreadable grouped child by the same neutral title as its card', async () => {
        const preset = WidgetAreaPresetStateV1Schema.parse({ id: 'overview', name: 'Overview', isEdited: true, changes: [
            { kind: 'removed', item: { kind: 'group', id: 'group', width: 'full', children: [
                { kind: 'widget', instance: { v: 1, id: 'private-child-id', definition: { kind: 'artifact', artifactId: 'unreadable' }, bindings: {} } },
            ] } },
        ] });
        const screen = await renderScreen(<WidgetAreaPresetLine preset={preset} surface={surface} testID="line" />);
        expect(screen.getTextContent()).toContain(t('composerReferences.kindWidget'));
        expect(screen.getTextContent()).not.toContain('private-child-id');
    });

    it('names what changed, by the widgets\' own names, with Reset at hand', async () => {
        const preset: WidgetAreaPresetStateV1 = { id: 'overview', name: 'Overview', isEdited: true, changes: [
            { kind: 'moved', direction: 'up', item: widget('limits', 'Limits') },
            { kind: 'removed', item: widget('days', 'Active days') },
        ] };
        const screen = await renderScreen(<WidgetAreaPresetLine preset={preset} surface={surface} testID="line" />);
        const text = screen.getTextContent();
        expect(text).toContain('Overview');
        expect(text).toContain('Limits');
        expect(text).toContain('Active days');
        expect(screen.findByTestId('line.reset')).not.toBeNull();
    });
    it('names two changes and counts the rest instead of listing every one', async () => {
        const preset: WidgetAreaPresetStateV1 = { id: 'overview', name: 'Overview', isEdited: true, changes: [
            { kind: 'added', item: widget('a', 'Coach') }, { kind: 'changed', item: widget('b', 'Daily usage') },
            { kind: 'removed', item: widget('c', 'Recap') }, { kind: 'renamed' },
        ] };
        const screen = await renderScreen(<WidgetAreaPresetLine preset={preset} surface={surface} testID="line" />);
        const text = screen.getTextContent();
        expect(text).toContain('Coach');
        expect(text).toContain('Daily usage');
        expect(text).not.toContain('Recap');
        expect(text).toContain(t('widgetFrame.presetChangeList', {
            first: t('widgetFrame.presetAdded', { item: 'Coach' }),
            second: t('widgetFrame.presetChanged', { item: 'Daily usage' }),
            more: 2,
        }));
    });
});
