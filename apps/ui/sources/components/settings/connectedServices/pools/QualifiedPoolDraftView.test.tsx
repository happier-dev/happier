import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { CollectionDraftRow } from '@/components/ui/lists/collection/CollectionList';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { QualifiedPoolDraftView } from './QualifiedPoolDraftView';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); });

it('names the real collection draft as the pool is typed, clears on leaving and never creates before submit', async () => {
    const create = vi.fn();
    function DraftRow() {
        return <CollectionDraftRow testID="pool-draft-title" titles={useCollectionDraftTitle()} placeholder="Untitled pool" />;
    }
    const element = (shown: boolean) => <CollectionDraftTitleScope><DraftRow />{shown ? <QualifiedPoolDraftView
        serviceLabel="Work service" accounts={[]} creating={false} onCreate={create} onDiscard={() => {}}
        presentIdentity={input => presentConnectedAccountIdentity({ ...input, hidden: false,
            label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null })}
    /> : null}</CollectionDraftTitleScope>;
    const screen = await renderScreen(element(true));
    const field = screen.tree.root.findAll(node => node.props.testID === 'connected-services-pool-draft:name'
        && typeof node.props.onDraftChange === 'function')[0];
    expect(field).toBeDefined();
    // Until it is named, the page is called what its draft row is called.
    expect(screen.getTextContent()).toContain('connectedServicesCollection.newPoolDraft(service=Work service)');
    await act(async () => { field!.props.onDraftChange(' Work pool '); });
    expect(screen.findHostByTestId('pool-draft-title')!.findAll(node => node.children.includes('Work pool'))).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    await screen.update(element(false));
    expect(screen.findHostByTestId('pool-draft-title')!.findAll(node => node.children.includes('Untitled pool'))).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
});
