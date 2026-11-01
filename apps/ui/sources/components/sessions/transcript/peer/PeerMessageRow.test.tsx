import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import { collectHostText, renderScreen, standardCleanup } from '@/dev/testkit';

import { PeerMessageRow } from './PeerMessageRow';

afterEach(() => {
    standardCleanup();
});

describe('PeerMessageRow', () => {
    it.each([
        [{ name: 'general-purpose', handback: true }, 'Report from general-purpose'],
        [{ name: 'pr4', handback: false }, 'Message from pr4'],
        [{ name: null, handback: false }, 'Message from another agent'],
    ] as const)('labels the sender and reveals the delivered body on demand (%o)', async (peer, label) => {
        const screen = await renderScreen(
            <PeerMessageRow id="m1" createdAt={1} peer={peer} summary="Verdict: fixed.">
                <Text>FULL_BODY</Text>
            </PeerMessageRow>,
        );
        const collapsed = collectHostText(screen.tree).join(' ');
        expect(collapsed).toContain(label);
        expect(collapsed).toContain('Verdict: fixed.');
        expect(collapsed).not.toContain('FULL_BODY');
        expect(screen.findHostByTestId('transcript-peer-message-header')?.props).toMatchObject({
            accessibilityRole: 'button', accessibilityState: { expanded: false },
        });
        await screen.pressByTestIdAsync('transcript-peer-message-header');
        expect(collectHostText(screen.tree).join(' ')).toContain('FULL_BODY');
        expect(screen.findHostByTestId('transcript-peer-message-header')?.props.accessibilityState).toMatchObject({ expanded: true });
    });
});
