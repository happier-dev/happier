import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ConnectedServiceQuotaSummaryCardSection } from './ConnectedServiceQuotaSummaryCardSection';

describe('ConnectedServiceQuotaSummaryCardSection', () => {
    it('renders exhausted quota meters with zero fill width', async () => {
        const screen = await renderScreen(
            <ConnectedServiceQuotaSummaryCardSection
                title="Quotas"
                cards={[
                    {
                        key: 'service-a',
                        title: 'Service A',
                        value: '0%',
                        subtitle: 'Primary',
                        meters: [
                            {
                                key: 'weekly',
                                label: 'Weekly',
                                remainingPct: 0,
                                valueText: '0%',
                                status: 'ok',
                            },
                        ],
                    },
                ]}
            />,
        );

        const fill = screen.findByTestId('connected-service-quota-meter-fill-service-a-weekly');
        expect(fill).toBeTruthy();
        const styles = Array.isArray(fill!.props.style) ? fill!.props.style : [fill!.props.style];
        const widthStyle = styles.find((style) => style && typeof style === 'object' && 'width' in style) as
            | { width?: string }
            | undefined;

        expect(widthStyle?.width).toBe('0%');
    });
});
