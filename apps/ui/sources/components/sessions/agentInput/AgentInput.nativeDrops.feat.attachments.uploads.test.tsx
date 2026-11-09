import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ComposerStructuredInputMention } from './structuredInputMentions';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, { findNodeHandle: () => 42 }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
const { AgentInput } = await import('./AgentInput');
const { projectAgentInputAttachmentRowItems } = await import('./agentInputContracts');
const { useAttachmentDraftManager } = await import('@/components/sessions/attachments/useAttachmentDraftManager');
afterEach(async () => { await standardCleanup(); await home.reset(); });

it('routes a native folder through the shared intake and mentions it at the release offset with the same failure lifecycle', async () => {
    let drafts: readonly AttachmentDraft[] = [];
    let updateStatus: ((status: 'uploaded' | 'error') => void) | undefined;
    function Composer() {
        const [value, setValue] = React.useState('Before after');
        const [mentions, setMentions] = React.useState<readonly ComposerStructuredInputMention[]>([]);
        const manager = useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024 });
        drafts = manager.drafts;
        updateStatus = status => manager.applyDraftPatch(manager.drafts[0]!.id, { status, uploadedPath: '/uploads/Design', error: status === 'error' ? 'denied' : undefined });
        return <AgentInput value={value} onChangeText={setValue} onSend={() => {}} placeholder="Message"
            autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            structuredInputMentions={mentions} onStructuredInputMentionsChange={setMentions}
            onAttachmentsAdded={manager.addWebFiles}
            attachmentRowItems={projectAgentInputAttachmentRowItems({ transferAttachments: manager.agentInputAttachments })} />;
    }
    const screen = await renderScreen(<Composer />);
    const input = () => screen.tree.findByType('HappierComposerInput');
    const folder = { kind: 'folder', name: 'Design', mimeType: 'inode/directory', directories: ['empty'], entries: [
        { relativePath: 'icons/a.svg', source: { kind: 'native', uri: 'file:///cache/a.svg', name: 'a.svg', mimeType: 'image/svg+xml', sizeBytes: 3 } },
    ] } as const;
    await act(async () => input().props.onComposerAttachmentDrop({ nativeEvent: { sources: [folder], offset: 7, scope: input().props.attachmentDropScope } }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toEqual(folder);
    expect(input().props.value).toBe(`Before [Design](happier-ref:attachment:${drafts[0]!.id}) after`);
    expect(input().props.references).toEqual([expect.objectContaining({ start: 7, state: 'pending' })]);
    await act(async () => input().props.onComposerAttachmentDrop({ nativeEvent: { sources: [folder], offset: 7, scope: 'old-composer' } }));
    expect(drafts).toHaveLength(1);
    await act(async () => updateStatus?.('uploaded'));
    expect(input().props.references[0].state).toBe('ready');
    await act(async () => updateStatus?.('error'));
    expect(input().props.references[0].state).toBe('removed');
    const { prepareComposerSubmissionSnapshot } = await import('@/components/sessions/composer/composerSubmissionCoordinator');
    expect(prepareComposerSubmissionSnapshot({ text: input().props.value, references: input().props.references.map((reference: { ref: string; start: number; end: number }) => ({
        ...reference, kind: 'happier.attachment', token: input().props.value.slice(reference.start, reference.end),
    })), attachments: [] }, [])).toMatchObject({ text: 'Before  after', references: [] });
});
