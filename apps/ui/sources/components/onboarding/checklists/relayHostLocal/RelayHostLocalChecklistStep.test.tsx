import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PersonalHomeBootstrapAdmission } from '@/components/personalHome/bootstrap/PersonalHomeBootstrapAdmission';
import { RelayHostLocalChecklistStep } from './RelayHostLocalChecklistStep';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

type Primary = Readonly<{ disabled: boolean; onPress: () => void | Promise<void> }>;
function Runtime(props: Readonly<{ children: React.ReactNode }>) {
    return <div data-testid="full-bootstrap">{props.children}</div>;
}

describe('Add Home local bootstrap entry', () => {
    it('one primary action opens the full bootstrap admitted by the shell', async () => {
        const state: { primary: Primary | null } = { primary: null };
        const screen = await renderScreen(
            <PersonalHomeBootstrapAdmission admission="offer" runtime={Runtime}>
                <RelayHostLocalChecklistStep onWizardPrimaryChange={(value) => { state.primary = value; }} />
            </PersonalHomeBootstrapAdmission>,
        );
        expect(screen.findByTestId('full-bootstrap')).toBeNull();
        expect(state.primary?.disabled).toBe(false);
        await act(async () => { await state.primary?.onPress(); });
        expect(screen.findByTestId('full-bootstrap')).not.toBeNull();
    });

    it('does not offer new installation when admission is off', async () => {
        const state: { primary: Primary | null } = { primary: null };
        await renderScreen(
            <PersonalHomeBootstrapAdmission admission="off" runtime={Runtime}>
                <RelayHostLocalChecklistStep onWizardPrimaryChange={(value) => { state.primary = value; }} />
            </PersonalHomeBootstrapAdmission>,
        );
        expect(state.primary?.disabled).toBe(true);
    });
});
