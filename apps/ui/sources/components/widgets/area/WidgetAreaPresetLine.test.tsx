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
    // Phone lab p5 "Usage" (D23): one quiet meta line, "You changed this view.", with a Reset text button.
    it('says the view was changed in one line, naming no widget, with Reset at hand', async () => {
        const preset = WidgetAreaPresetStateV1Schema.parse({ id: 'overview', name: 'Overview', isEdited: true, changes: [
            { kind: 'removed', item: { kind: 'group', id: 'group', width: 'full', children: [
                { kind: 'widget', instance: { v: 1, id: 'private-child-id', definition: { kind: 'artifact', artifactId: 'unreadable' }, bindings: {} } },
            ] } },
            { kind: 'moved', direction: 'up', item: widget('limits', 'Limits') },
        ] });
        const screen = await renderScreen(<WidgetAreaPresetLine preset={preset} surface={surface} testID="line" />);
        const text = screen.getTextContent();
        expect(text).toContain(t('widgetFrame.presetChangedView'));
        expect(text).not.toContain('private-child-id');
        expect(text).not.toContain('Limits');
        expect(screen.findByTestId('line.reset')).not.toBeNull();
    });

    it('resets through the page\'s own preset Action', async () => {
        const preset: WidgetAreaPresetStateV1 = { id: 'overview', name: 'Overview', isEdited: true, changes: [] };
        const resets: unknown[] = [];
        const presetActions = {
            resetPreset: async (target?: unknown) => { resets.push(target); return { ok: false, error: { code: 'unavailable', message: 'no' } } as never; },
            undoReset: async () => ({ ok: false, error: { code: 'unavailable', message: 'no' } }) as never,
        };
        const screen = await renderScreen(<WidgetAreaPresetLine preset={preset} surface={surface} presetActions={presetActions} testID="line" />);
        await screen.pressByTestIdAsync('line.reset');
        expect(resets).toEqual([surface]);
    });
});
