import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { CaptureDeliveryPill, capturePillLeavesOnItsOwn } from './CaptureDeliveryPill';
import { resolveCaptureDeliveryOutcome } from './captureDeliveryOutcome';

afterEach(standardCleanup);

describe('CaptureDeliveryPill', () => {
    it('shows the added image ordinal and Session without presenting it as a capture count', async () => {
        // The desktop receipt numbers all images, including ordinary attachments already in the draft.
        const outcome = resolveCaptureDeliveryOutcome({ delivery: 'addToDraft', session: 'Checkout', detail: '/repo', result: {
            windowLabel: 'capture', requestId: 'request', ok: true, result: { captureRef: 'first-screenshot', imageNumber: 2 },
        } });
        if (!outcome.ok) throw new Error('Expected successful capture delivery');
        const screen = await renderScreen(React.createElement(CaptureDeliveryPill, { state: outcome.pill, thumbnailUri: null }));
        const lines = screen.findAllByType(Text).map(line => line.props.children);
        expect(lines).toEqual([t('screenCapture.pill.added', { number: 2 }), 'Checkout']);
    });
});

describe('capturePillLeavesOnItsOwn', () => {
    it('holds a failure and anything still under way; a settled line leaves', () => {
        expect(capturePillLeavesOnItsOwn({ kind: 'failed', session: 'A', cause: 'x' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'sending', session: 'A' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'adding', session: 'A' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'sent', session: 'A', detail: 'B' })).toBe(true);
        expect(capturePillLeavesOnItsOwn({ kind: 'added', session: 'A', imageNumber: 2 })).toBe(true);
        expect(capturePillLeavesOnItsOwn({ kind: 'discarded' })).toBe(true);
    });
});
