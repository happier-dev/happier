import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';

import { SessionAuthoringChipDescriptorTrigger } from './SessionAuthoringFieldSelectTrigger';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(standardCleanup);

function descriptor(fieldValue?: string): AgentInputExtraActionChip {
    return {
        key: 'auth',
        placement: { id: 'connectedServices', title: 'Runs through' },
        collapsedContentPopover: {
            title: 'Runs through ChatGPT · Work',
            label: 'Runs through ChatGPT · Work',
            ...(fieldValue === undefined ? {} : { fieldValue }),
            renderContent: () => null,
        },
        render: () => null,
    } as unknown as AgentInputExtraActionChip;
}

async function renderTrigger(chip: AgentInputExtraActionChip) {
    const anchorRef = React.createRef<React.ComponentRef<typeof View>>();
    return renderScreen(<SessionAuthoringChipDescriptorTrigger chip={chip} renderContext={{} as never} trigger="select"
        anchorRef={anchorRef} open={false} onToggle={() => {}} testID="auth" />);
}

describe('SessionAuthoringChipDescriptorTrigger', () => {
    // WF-ACCEPT-1118B item 5: in a row of field selects (the How card's Who runs it) a descriptor with a value of its
    // own shows that value and names its field apart, so the row holds one line instead of a long verb phrase.
    it('shows a descriptor\'s own value in the field select and names its field apart', async () => {
        const screen = await renderTrigger(descriptor('ChatGPT · Work'));
        expect(screen.getTextContent()).toContain('ChatGPT · Work');
        expect(screen.getTextContent()).not.toContain('Runs through ChatGPT');
        expect(screen.findByTestId('auth-select')?.props.accessibilityLabel).toBe('Runs through: ChatGPT · Work');
    });

    it('keeps the whole label when the descriptor has no separate value', async () => {
        const screen = await renderTrigger(descriptor());
        expect(screen.getTextContent()).toContain('Runs through ChatGPT · Work');
    });
});
