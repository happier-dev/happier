import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { findAllHostTestInstances, renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Native render/style and navigation APIs are platform boundaries. Diagnosis,
// its parser, state, controls and machine-snapshot owner all remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(async () => {
    await standardCleanup();
    await home.reset();
});

it('leaves an untouched paste field neutral and validates only the supplied document', async () => {
    await home.addHome({ name: 'Diagnosis', serverUrl: 'https://diagnosis-paste.test', accountId: 'account' });
    const { DiagnosisView } = await import('./DiagnosisView');
    const screen = await renderScreen(<DiagnosisView />);
    const announcements = () => findAllHostTestInstances(screen.root, node => node.props.accessibilityLiveRegion === 'polite');

    expect(announcements()).toHaveLength(0);
    expect(screen.findByTestId('diagnosis-parse-button')?.props.disabled).toBe(true);

    await act(async () => { screen.changeTextByTestId('diagnosis-paste-input', '{invalid'); });
    expect(announcements()).toHaveLength(0);
    await act(async () => { await screen.pressByTestIdAsync('diagnosis-parse-button'); });
    expect(announcements()).toHaveLength(1);

    await act(async () => { screen.changeTextByTestId('diagnosis-paste-input', ''); });
    expect(announcements()).toHaveLength(0);
    expect(screen.findByTestId('diagnosis-parse-button')?.props.disabled).toBe(true);
});
