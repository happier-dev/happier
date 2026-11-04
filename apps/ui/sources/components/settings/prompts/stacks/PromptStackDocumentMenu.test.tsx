import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Portal placement and window measurement are browser boundaries; menu filtering and selection stay real.
vi.mock('@/components/ui/popover', async original => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(original);
});

await initializeArtifactInventoryDemandHarness();
const { PromptStackDocumentMenu } = await import('./PromptStackDocumentMenu');
const { t } = await import('@/text');
const { storage } = await import('@/sync/domains/state/storage');

describe('Prompt document attachment inventory', () => {
    let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
    beforeEach(async () => {
        fixture = await createArtifactInventoryDemandHarness();
        fixture.inventory = Array.from({ length: 56 }, (_, index) => ({
            ...fixture.inventory[0]!, id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
            header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: `Instructions ${index + 1}` }),
        }));
    });
    afterEach(async () => { await fixture?.dispose(); vi.restoreAllMocks(); });

    const menu = (onPick = vi.fn(), serverId = storage.getState().profileScope!.serverId) => (
        <PromptStackDocumentMenu testID="instructions.attach" anchorRef={{ current: null }}
            serverId={serverId} purpose="instructions" onClose={() => {}} onPick={onPick} />
    );

    it('reads the open Instructions picker without claiming an unfinished library is empty', async () => {
        const started = createDeferred<AbortSignal | null | undefined>();
        const release = createDeferred<void>();
        fixture.holdList = async signal => { started.resolve(signal); await release.promise; };
        const onPick = vi.fn();
        const screen = await renderScreen(menu(onPick));
        try {
            expect(screen.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
            expect(screen.getTextContent()).toContain(t('common.loading'));
            await started.promise;
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(['prompt_doc.v2']), headers: 56 }]);
            expect(fixture.bodyReads).toEqual([]);
            await screen.update(menu(onPick));
            expect(fixture.pages).toHaveLength(1);
            fixture.holdList = null;
            await act(async () => { release.resolve(); await fixture.settleInventory(); });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Instructions 56'));
            expect(screen.getTextContent()).not.toContain(t('common.loading'));
            expect(screen.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
            expect(fixture.pages).toHaveLength(1);
            await screen.pressByTestIdAsync(`dropdown-option-${fixture.inventory[55]!.id}`);
            await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith({ kind: 'doc', artifactId: fixture.inventory[55]!.id,
                serverId: storage.getState().profileScope!.serverId }, 'Instructions 56'));
        } finally { release.resolve(); fixture.holdList = null; await screen.unmount(); }
    }, 120_000);

    it('retains ready choices through unrelated publication and a failed refresh, then recovers in place', async () => {
        const screen = await renderScreen(menu());
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Instructions 56'));
            await fixture.settleInventory();
            expect(fixture.pages).toHaveLength(1);
            const row = storage.getState().artifacts[fixture.inventory[0]!.id]!;
            if (!row.isDecrypted) throw new Error('Expected the ready inventory document to be decrypted');
            await act(async () => { storage.getState().updateArtifact({ ...row, id: 'unrelated-document',
                header: { kind: 'markdown', title: 'Unrelated document' } }); });
            expect(screen.getTextContent()).toContain('Instructions 56');
            expect(screen.getTextContent()).not.toContain(t('common.loading'));
            expect(screen.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
            expect(fixture.pages).toHaveLength(1);
            fixture.listFailure = 403;
            await act(async () => {
                await expect(fixture.recoverSnapshot()).rejects.toMatchObject({ name: 'HappyError', status: 403, canTryAgain: false });
            });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('common.error')));
            expect(screen.getTextContent()).toContain('Instructions 56');
            expect(screen.getTextContent()).not.toContain(t('common.loading'));
            expect(screen.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
            fixture.listFailure = null;
            fixture.inventory[55] = { ...fixture.inventory[55]!, headerVersion: 2,
                header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Updated instructions' }) };
            await screen.pressByTestIdAsync('instructions.attach.readState-action');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Updated instructions'));
            expect(screen.getTextContent()).not.toContain(t('common.error'));
            expect(fixture.bodyReads).toEqual([]);
        } finally { await screen.unmount(); }
    }, 120_000);

    it('settles a failed read without an empty claim and retries through the same inventory owner', async () => {
        fixture.listFailure = 403;
        const screen = await renderScreen(menu());
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('common.error')));
            expect(screen.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
            fixture.listFailure = null;
            fixture.inventory = [];
            await screen.pressByTestIdAsync('instructions.attach.readState-action');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('contextPages.addDocumentEmpty')));
            expect(screen.getTextContent()).not.toContain(t('common.error'));
            expect(fixture.pages).toEqual([{ kinds: JSON.stringify(['prompt_doc.v2']), headers: 0 }]);
        } finally { await screen.unmount(); }
    }, 120_000);

    it('withdraws the picker read on close without acquiring another Home or reading document bodies', async () => {
        const started = createDeferred<AbortSignal | null | undefined>();
        const release = createDeferred<void>();
        fixture.holdList = async signal => { started.resolve(signal); await release.promise; };
        const screen = await renderScreen(menu());
        try {
            const signal = await started.promise;
            await screen.unmount();
            expect(signal?.aborted).toBe(true);
            release.resolve();
            fixture.holdList = null;
            await fixture.settleInventory();
            fixture.pages.length = 0;
            const otherHome = await renderScreen(menu(vi.fn(), 'unaddressed-home'));
            try {
                expect(otherHome.getTextContent()).not.toContain(t('contextPages.addDocumentEmpty'));
                expect(otherHome.getTextContent()).toContain(t('common.error'));
                await fixture.recoverSnapshot();
                expect(fixture.pages).toEqual([]);
                expect(fixture.bodyReads).toEqual([]);
            } finally { await otherHome.unmount(); }
        } finally { release.resolve(); fixture.holdList = null; await screen.unmount(); }
    }, 120_000);
});
