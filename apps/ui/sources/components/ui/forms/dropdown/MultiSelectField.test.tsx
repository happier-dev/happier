import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

const { MultiSelectField } = await import('./MultiSelectField');
const { DropdownMenu } = await import('./DropdownMenu');

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('MultiSelectField', () => {
    it('shows a disabled candidate unchecked while keeping its stored id for the commit', async () => {
        const onCommit = vi.fn();
        const screen = await renderScreen(
            <MultiSelectField
                title="Places"
                candidates={[
                    { id: 'home', title: 'Home' },
                    { id: 'pages', title: 'Other pages', disabled: true, subtitle: 'The planet stays on Home' },
                ]}
                selectedIds={['home', 'pages']}
                onCommit={onCommit}
                subtitle={() => ''}
                emptySubtitle="Nowhere"
                searchPlaceholder="Places"
                optionTestIDPrefix="place"
            />,
        );
        const items = screen.findAllByType(DropdownMenu)[0]?.props.items as ReadonlyArray<{ id: string; disabled?: boolean; icon: React.ReactElement<{ children: React.ReactElement<{ name: string }> }> }>;
        expect(items.map((item) => [item.id, item.disabled === true, item.icon.props.children.props.name])).toEqual([
            ['home', false, 'check-square'],
            ['pages', true, 'square'],
        ]);
    });
});
