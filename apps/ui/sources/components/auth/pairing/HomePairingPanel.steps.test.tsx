import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { HomePairingPanel } = await import('./HomePairingPanel');
const { t } = await import('@/text');

beforeEach(async () => { await homes.reset(); });
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

it('names each step of adding another machine in words, and offers the code to scan in its own section', async () => {
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <HomePairingPanel purpose="computer" layout="section" testIDPrefix="computer" />
    </InjectedAuthProvider>);
    try {
        const text = screen.getTextContent();
        const home = t('homeSetup.thisHome');
        // Three worded steps: what to do there, the link and what opening it does, and how it ends.
        for (const words of [
            t('homeSetup.pairingComputerStepInstallTitle'), t('homeSetup.pairingComputerStepInstallDetail'),
            t('homeSetup.pairingComputerStepOpenTitle'), t('homeSetup.pairingComputerBody', { home }),
            t('homeSetup.pairingComputerStepJoinTitle'), t('homeSetup.pairingComputerStepJoin'),
            t('homeSetup.pairingScanTitle'), t('homeSetup.pairingScanBody'),
        ]) expect(text).toContain(words);
        // The link's handover sits in its step; the code is drawn once, in the scan section.
        expect(screen.findAllByTestId('computer-copy-link').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('computer-qr').length + screen.findAllByTestId('computer-qr-placeholder').length).toBe(1);
        expect(screen.findAllByTestId('computer-scan').length).toBeGreaterThan(0);
    } finally {
        await screen.unmount();
    }
});
