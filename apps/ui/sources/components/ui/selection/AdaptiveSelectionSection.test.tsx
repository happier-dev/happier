import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { AdaptiveSelectionSection } from './AdaptiveSelectionSection';

describe('AdaptiveSelectionSection', () => {
    it('renders expanded content when presentation resolves to expanded', async () => {
        const screen = await renderScreen(
            <AdaptiveSelectionSection
                presentation="expanded"
                expandedContent={React.createElement('expanded-content', { testID: 'expanded-content' })}
                compactContent={React.createElement('compact-content', { testID: 'compact-content' })}
            />,
        );

        expect(screen.findAllByProps({ testID: 'expanded-content' })).toHaveLength(1);
        expect(screen.findAllByProps({ testID: 'compact-content' })).toHaveLength(0);
    });

    it('renders quick content before compact content when presentation resolves to compact', async () => {
        const screen = await renderScreen(
            <AdaptiveSelectionSection
                presentation="compact"
                quickContent={React.createElement('quick-content', { testID: 'quick-content' })}
                expandedContent={React.createElement('expanded-content', { testID: 'expanded-content' })}
                compactContent={React.createElement('compact-content', { testID: 'compact-content' })}
            />,
        );

        expect(screen.findAllByProps({ testID: 'expanded-content' })).toHaveLength(0);
        const rendered = screen.root.findAll((node) => (
            node.props?.testID === 'quick-content' || node.props?.testID === 'compact-content'
        ));
        expect(rendered.map((node) => node.props.testID)).toEqual(['quick-content', 'compact-content']);
    });
});
