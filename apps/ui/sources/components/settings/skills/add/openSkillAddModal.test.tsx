import * as React from 'react';
import { describe, expect, it, onTestFailed, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import type { CodeEditorProps, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

installPromptRegistriesCommonModuleMocks({
    storage: original => original(),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const uploadDrop = vi.hoisted(() => ({ accept: null as null | ((event: { dataTransfer: unknown }) => Promise<void>) }));
// File-drop event delivery and directory handles are browser boundaries; upload bytes and install stay real.
vi.mock('@/hooks/ui/useWebFileDropZone', () => ({ useWebFileDropZone: (input: {
    onFilesDropped: (event: { dataTransfer: unknown }) => Promise<void>;
}) => { uploadDrop.accept = input.onFilesDropped; return {}; } }));
vi.mock('@/utils/files/webDroppedEntries', () => ({ readWebDroppedEntries: async (transfer: {
    entries: readonly { file: File; relativePath: string }[];
}) => transfer.entries }));
// Monaco/native editor is the platform boundary; the real Skill editor, lint and explicit create stay mounted.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
    const React = await import('react');
    return { CodeEditor: React.forwardRef<TextEditorHandle, CodeEditorProps>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ getValue: () => props.value, flushPendingChange: async () => {} }), [props.value]);
        return React.createElement('SkillEditorBoundary', { testID: props.testID, value: props.value, onChangeText: props.onChange });
    }) };
});
const { createRegistrySourcesUiHome } = await import('@/dev/testkit/harness/registrySourcesUiHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
const { SkillAddModal } = await import('./openSkillAddModal');
const { SkillAddDetailBody } = await import('./SkillAddDetailBody');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const { StoreSkillListing } = await import('@/components/store/StoreSkillListing');

describe('Skills Add modal through the real Account and registry owners', () => {
    it('reopens an added Store Skill with its saved Off reach through the native controller', async () => {
        const { sourceId, home, skill } = await createRegistrySourcesUiHome('store-listing-controller');
        const listing = (key: string) => <StoreSkillListing key={key} selection={{ sourceId, itemId: 'review', version: skill.item.summary.version }}
            onClose={() => {}}>{state => state.config ? <CapabilityAddModalBody config={state.config} onClose={state.requestClose} /> : null}
        </StoreSkillListing>;
        const screen = await renderScreen(listing('first'));
        const reveal = async () => {
            await waitForHomeGovernance(() => expect(screen.findAllByTestId('skills.add:collection:stage').length).toBeGreaterThan(0));
            const stage = screen.find(node => node.props.testID === 'skills.add:collection:stage' && typeof node.props.onLayout === 'function');
            await React.act(async () => stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 700 } } }));
        };
        await reveal();
        const config = () => screen.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        await waitForHomeGovernance(() => expect(config().detailFooter(config().catalog.items[0]!).primary.disabledReason).toBeUndefined());
        await React.act(async () => { await screen.findByType(WhereItsOnControl).props.onChange({ kind: 'replace', rules: [] }); });
        await React.act(async () => { await config().detailFooter(config().catalog.items[0]!).primary.onPress(); });
        expect(home.boundary.list()).toHaveLength(1);
        await screen.update(listing('reopened'));
        await reveal();
        await waitForHomeGovernance(() => expect(config().detailFooter(config().catalog.items[0]!).primary.label).toBe('capabilities.skillAdd.open'));
        expect(screen.findByType(WhereItsOnControl).props.rules).toEqual([]);
    });
    it('opens an exact unpinned Skill seed without listing or resolving a title as identity', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('store-exact-seed');
        const actionFrontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const calls: Array<{ action: string; input: unknown }> = [];
        const create = actionFrontDoor.createFrontDoorActionExecute;
        const spy = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
            const execute = create(...args);
            return Object.assign((...invocation: Parameters<typeof execute>) => {
                if (invocation[0].startsWith('registries.items.')) calls.push({ action: invocation[0], input: invocation[1] });
                return execute(...invocation);
            }, { prepare: execute.prepare });
        });
        try {
            const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{
                initialSelection: { sourceId, itemId: 'review' },
            }} />);
            const config = () => screen.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
            await waitForHomeGovernance(() => expect(config().catalog.loading).toBe(false));
            expect(config().catalog.items.map(row => row.itemId)).toEqual(['review']);
            expect(calls.filter(call => call.action === 'registries.items.list')).toHaveLength(0);
            const stage = screen.find(node => node.props.testID === 'skills.add:collection:stage' && typeof node.props.onLayout === 'function');
            await React.act(async () => stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 700 } } }));
            await waitForHomeGovernance(() => expect(calls.some(call => call.action === 'registries.items.read')).toBe(true));
            expect(calls.find(call => call.action === 'registries.items.read')?.input).toEqual({ kind: 'skill', sourceId, itemId: 'review' });
        } finally { spy.mockRestore(); }
    });
    it('keeps a newer Link open when an exit Save acknowledges an earlier source', async () => {
        const started = createDeferred<void>(), release = createDeferred<void>();
        const { home, sourceId } = await createRegistrySourcesUiHome('link-save-late-ack', {
            // Gate Home HTTP, not the install/receipt logic above it.
            handleRequest: async (path, init) => {
                if (path === '/v1/artifacts' && init?.method === 'POST') { started.resolve(); await release.promise; }
                return null;
            },
        });
        const { Modal } = await import('@/modal');
        const onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'link', sourceId }} />);
        try {
            await React.act(async () => screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills/tree/main/review'));
            await screen.pressByTestIdAsync('skills.add.link.find');
            await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
            await React.act(async () => { screen.pressByTestId('skills.add:close'); });
            await React.act(async () => { void vi.mocked(Modal.alert).mock.calls.at(-1)![2]!
                .find(button => button.style !== 'cancel' && button.style !== 'destructive')!.onPress!(); });
            await started.promise;
            await React.act(async () => screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/another-skill'));
            await React.act(async () => release.resolve());
            // The one Add (the details') shows the exit Save in flight.
            await waitForHomeGovernance(() => expect(screen.findAllByTestId('skills.add:primary')
                .find(node => typeof node.props.loading === 'boolean')?.props.loading).toBe(false));
            expect(home.boundary.list()).toHaveLength(1);
            expect(onClose).not.toHaveBeenCalled();
            expect(screen.findAllByTestId('skills.add.link.url').find(node => typeof node.props.value === 'string')?.props.value)
                .toBe('https://github.com/fixture/another-skill');
        } finally { release.resolve(); }
    });

    it.each(['link', 'upload'] as const)('saves a valid %s preview through its existing Found owner before closing', async modeKey => {
        const { home, sourceId } = await createRegistrySourcesUiHome(`${modeKey}-exit-save`);
        const { Modal } = await import('@/modal');
        const onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey, sourceId }} />);
        if (modeKey === 'link') {
            await React.act(async () => screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills/tree/main/review'));
            await screen.pressByTestIdAsync('skills.add.link.find');
            await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        } else {
            await React.act(async () => uploadDrop.accept!({ dataTransfer: { entries: [
                { file: new File(['---\nname: release-notes\ndescription: Explain changes.\n---\nRead the diff.'], 'SKILL.md'), relativePath: 'release-notes/SKILL.md' },
            ] } }));
            await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        }
        expect(home.boundary.list()).toHaveLength(0);
        vi.mocked(Modal.alert).mockClear();
        await React.act(async () => { screen.pressByTestId('skills.add:close'); });
        const save = vi.mocked(Modal.alert).mock.calls.at(-1)![2]!.find(button => button.style !== 'cancel' && button.style !== 'destructive');
        expect(save).toBeDefined();
        await React.act(async () => save!.onPress!());
        await waitForHomeGovernance(() => expect(onClose).toHaveBeenCalledOnce());
        expect(home.boundary.list()).toHaveLength(1);
    });

    it('guards a newly typed Link after an earlier Link was acknowledged and kept open', async () => {
        const { home, sourceId } = await createRegistrySourcesUiHome('link-after-receipt');
        const { Modal } = await import('@/modal');
        const { SkillInstructionsSection } = await import('../detail/SkillInstructionsSection');
        const { SKILL_DRAFT_TEMPLATE } = await import('../detail/skillDraftTemplate');
        const onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'write', sourceId }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('skill.draft.header')).not.toBeNull());
        await React.act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(`${SKILL_DRAFT_TEMPLATE}\nUnsaved instructions.`));
        await React.act(async () => screen.pressByTestId('skills.add:mode:link'));
        await React.act(async () => screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills/tree/main/review'));
        await screen.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        vi.mocked(Modal.alert).mockClear();
        await React.act(async () => { screen.pressByTestId('skills.add:primary'); });
        await waitForHomeGovernance(() => expect(Modal.alert).toHaveBeenCalled());
        await React.act(async () => vi.mocked(Modal.alert).mock.calls.at(-1)![2]!.find(button => button.style === 'cancel')!.onPress!());
        expect(home.boundary.list()).toHaveLength(1);
        await React.act(async () => screen.pressByTestId('skills.add:mode:write'));
        await React.act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(SKILL_DRAFT_TEMPLATE));
        await React.act(async () => screen.pressByTestId('skills.add:mode:link'));
        await React.act(async () => screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/another-skill'));
        vi.mocked(Modal.alert).mockClear();
        await React.act(async () => { screen.pressByTestId('skills.add:close'); });
        expect(onClose).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalled();
        await React.act(async () => vi.mocked(Modal.alert).mock.calls.at(-1)![2]!.find(button => button.style === 'cancel')!.onPress!());
        expect(home.boundary.list()).toHaveLength(1);
    });

    it('guards a dirty Write close with Keep editing and Discard through the shared decision', async () => {
        await createRegistrySourcesUiHome('write-dirty-close');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'write' }} />);
        const { SkillInstructionsSection } = await import('../detail/SkillInstructionsSection');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skill.draft.header')).not.toBeNull());
        const text = '---\nname: release-notes\ndescription: Explain changes.\n---\nRead the diff.';
        await React.act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(text));
        await React.act(async () => { screen.pressByTestId('skills.add:close'); });
        expect(onClose).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalled();
        const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)![2]!;
        await React.act(async () => buttons.find(button => button.style === 'cancel')!.onPress!());
        expect(screen.findByType(SkillInstructionsSection).props.draft.text).toBe(text);
        await React.act(async () => { screen.pressByTestId('skills.add:close'); });
        await React.act(async () => vi.mocked(Modal.alert).mock.calls.at(-1)![2]!.find(button => button.style === 'destructive')!.onPress!());
        await waitForHomeGovernance(() => expect(onClose).toHaveBeenCalledOnce());
    });

    it('retains an Upload preview and binary files across mode visits before explicit Add', async () => {
        const { home, sourceId, externalRequests } = await createRegistrySourcesUiHome('upload-mode-return');
        const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{ modeKey: 'upload', sourceId }} />);
        const bytes = new Uint8Array([0, 255, 128, 10]);
        await React.act(async () => uploadDrop.accept!({ dataTransfer: { entries: [
            { file: new File(['---\nname: release-notes\ndescription: Explain changes.\n---\nRead the diff.'], 'SKILL.md'), relativePath: 'release-notes/SKILL.md' },
            { file: new File([bytes], 'sample.bin'), relativePath: 'release-notes/sample.bin' },
        ] } }));
        expect(home.boundary.list()).toHaveLength(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        await React.act(async () => screen.pressByTestId('skills.add:mode:link'));
        await React.act(async () => screen.pressByTestId('skills.add:mode:upload'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        const { PromptBundleBodyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptBundleSchemas');
        const body = PromptBundleBodyV1Schema.parse(JSON.parse(home.boundary.readPlainBody(home.boundary.list()[0]!.id)!));
        expect(body.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'sample.bin', contentBase64: Buffer.from(bytes).toString('base64') }),
        ]));
        expect(externalRequests.filter(url => url.includes('api.github.com/repos/fixture/skills'))).toHaveLength(0);
    });

    it('retains the Link draft and preview across mode visits without loading Browse', async () => {
        const { home, sourceId, externalRequests } = await createRegistrySourcesUiHome('link-mode-return');
        const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{ modeKey: 'link', sourceId }} />);
        const url = 'https://github.com/fixture/skills/tree/main/review';
        await React.act(async () => screen.changeTextByTestId('skills.add.link.url', url));
        await screen.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')).not.toBeNull());
        const before = externalRequests.length;
        await React.act(async () => screen.pressByTestId('skills.add:mode:upload'));
        await React.act(async () => screen.pressByTestId('skills.add:mode:link'));
        expect(screen.findAllByTestId('skills.add.link.url').find(node => typeof node.props.value === 'string')?.props.value).toBe(url);
        expect(screen.findByTestId('skills.add:primary')).not.toBeNull();
        expect(externalRequests).toHaveLength(before);
        expect(home.boundary.list()).toHaveLength(0);
    });

    it('keeps Write in the modal, preserves its draft on mode visits, and creates only on Add', async () => {
        const { home, sourceId, externalRequests } = await createRegistrySourcesUiHome('modal-write');
        const onClose = vi.fn(), onAdded = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'write', sourceId, onAdded }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('skill.draft.header')).not.toBeNull());
        expect(home.boundary.list()).toHaveLength(0);
        expect(externalRequests.filter(url => url.includes('api.github.com/repos/fixture/skills'))).toHaveLength(0);
        const { SkillInstructionsSection } = await import('../detail/SkillInstructionsSection');
        // Without a description agents can't tell when to use it: the one Add stays disabled, naming that repair.
        await React.act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange('---\nname: release-notes\n---\nRead the diff.'));
        expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(true);
        const text = '---\nname: release-notes\ndescription: Explain the changes.\n---\nRead the diff.';
        await React.act(async () => screen.findByType(SkillInstructionsSection).props.draft.onChange(text));
        expect(home.boundary.list()).toHaveLength(0);
        await React.act(async () => screen.pressByTestId('skills.add:mode:link'));
        await React.act(async () => screen.pressByTestId('skills.add:mode:write'));
        expect(screen.findByType(SkillInstructionsSection).props.draft.text).toBe(text);
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:open-added')).not.toBeNull());
        await screen.pressByTestIdAsync('skills.add:open-added');
        expect(onAdded).toHaveBeenCalledExactlyOnceWith(home.boundary.list()[0]!.id);
        expect(home.boundary.list()).toHaveLength(1);
    });

    it('lands on the first wide Skill and exposes only its reviewed detail operation', async () => {
        const { sourceId, skill, home, moveBranch } = await createRegistrySourcesUiHome('first-reviewed-skill');
        const onClose = vi.fn(), onAdded = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId, onAdded }} />);
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && node.props.model?.keys);
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${sourceId}|review`));
        const config = screen.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        expect(config.catalog.anatomy.action?.(skill.item.summary) ?? null).toBeNull();
        moveBranch();
        await React.act(async () => screen.find(node => node.props.testID === 'skills.add:collection:stage'
            && typeof node.props.onLayout === 'function').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 600 } } }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('skills.add:primary').find(node => typeof node.props.loading === 'boolean')?.props.loading).toBe(false));
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(onAdded).toHaveBeenCalledExactlyOnceWith(home.boundary.list()[0]!.id));
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().artifacts[home.boundary.list()[0]!.id]?.header).toMatchObject({ skillLock: { provenance: {
            kind: 'registry', registry: { sourceId, itemId: 'review', ref: { commit: skill.item.summary.version } },
        } } });
    });

    it('opens a shelf card independently of its Add control through the real Collection', async () => {
        const { skill } = await createRegistrySourcesUiHome('shelf-open');
        const { RegistryShelf, registryShelfProjection } = await import('@/components/capabilities/add/RegistryShelf');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const onOpen = vi.fn(), onAdd = vi.fn();
        type Choice = Readonly<{ native: RegistryItemSummaryV1 }>;
        const projection = { keyOf: (item: Choice) => registryShelfProjection.keyOf(item.native),
            title: (item: Choice) => item.native.title, description: (item: Choice) => item.native.description ?? null,
            testID: (item: Choice) => item.native.itemId };
        const shelf = (items: readonly RegistryItemSummaryV1[], loading: boolean) => <RegistryShelf projection={projection} testID="shelf" title="Skills" items={items.map(native => ({ native }))}
            loading={loading} where={() => null} columnTitle="Skill" onOpen={item => onOpen(item.native)}
            action={() => <RoundButton testID="shelf.add" title="Add" onPress={onAdd} />} />;
        const screen = await renderScreen(shelf([], true));
        expect(screen.findHostByTestId('shelf:skeleton-card')).not.toBeNull();
        await React.act(async () => screen.update(shelf([skill.item.summary], false)));
        await React.act(async () => {
            screen.find(node => node.props.testID === 'shelf:stage' && typeof node.props.onLayout === 'function')
                .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 800 } } });
        });
        await screen.pressByTestIdAsync('shelf.add');
        expect(onAdd).toHaveBeenCalledOnce();
        expect(onOpen).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(`shelf.${skill.item.summary.itemId}`);
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(skill.item.summary);
        expect(onAdd).toHaveBeenCalledOnce();
        await React.act(async () => screen.update(shelf([], false)));
        expect(screen.findHostByTestId('shelf:stage')).toBeNull();
    });

    it('opens Skills shelf inspection in its source and query, then opens the installed skill home', async () => {
        const { home, sourceId, skill } = await createRegistrySourcesUiHome('shelf-inspection');
        const { SkillsRegistryShelf } = await import('../SkillsRegistryShelf');
        const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
        const { Modal } = await import('@/modal');
        const { skillHref } = await import('../skillsCollectionModel');
        function Shelf() {
            const library = useSkillsLibrary();
            return <SkillsRegistryShelf library={library} shelf={{ items: [skill.item.summary], sourceId, loading: false,
                error: null, status: null, sourceFailures: [], refresh: async () => {} }} brandNew={false} />;
        }
        const screen = await renderScreen(<Shelf />);
        await React.act(async () => {
            screen.find(node => node.props.testID === 'skills.home.shelf:stage' && typeof node.props.onLayout === 'function')
                .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 800 } } });
        });
        vi.mocked(Modal.show).mockClear();
        promptRegistriesRouterPushSpy.mockClear();
        await screen.pressByTestIdAsync('skills.home.shelf.review');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ component: SkillAddModal,
            props: expect.objectContaining({ params: expect.objectContaining({ modeKey: 'browse', sourceId, query: skill.item.summary.title }) }) }));
        expect(home.boundary.list()).toHaveLength(0);
        vi.mocked(Modal.show).mockClear();
        await screen.pressByTestIdAsync('skills.home.shelf.review.add');
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.home.shelf.review.added')).not.toBeNull());
        expect(Modal.show).not.toHaveBeenCalled();
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('skills.home.shelf.review');
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledExactlyOnceWith(skillHref(home.boundary.list()[0]!.id));
        expect(Modal.show).not.toHaveBeenCalled();
    });

    it.each([
        ['en-US', 1000, '1k'],
        ['en-US', 1_000_000, '1m'],
        ['ja-JP', 1_000_000, '100万'],
    ] as const)('shares %s compact counts for %i tokens without registry popularity', async (locale, count, shown) => {
        const nativeNumberFormat = Intl.NumberFormat;
        // Intl is the platform locale boundary; all presenters and formatters below remain real.
        const numberFormat = vi.spyOn(Intl, 'NumberFormat').mockImplementation((locales, options) =>
            new nativeNumberFormat(locales ?? locale, options));
        try {
            const { sourceId, skill } = await createRegistrySourcesUiHome(`counts-${locale}-${count}`);
            const modal = await renderScreen(<SkillAddModal onClose={() => {}} params={{ sourceId, modeKey: 'link' }} />);
            const config = modal.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
            // Native host tests have no measured Collection viewport: render its actual row-facts slot.
            const facts = await renderScreen(<>{config.catalog.anatomy.byline?.({ ...skill.item.summary, installs: count })}</>);
            expect(facts.getTextContent()).not.toContain(shown);
            const detail = await renderScreen(<SkillAddDetailBody title="Review" purpose={null}
                facts={{ presentation: 'row', cost: { tokensWhenUsed: count } }}
                installs={{ trust: 'text_only', scripts: 0, files: [], cost: { bodyTokens: count, descriptionTokens: 10 } }}
                outsideReferences={[]} onWhereChange={() => {}} testID="counts-detail" />);
            expect(detail.getTextContent()).toContain(`capabilities.facts.tokensWhenUsed(count=${shown})`);
            expect(detail.getTextContent()).toContain(`capabilities.skillAdd.detail.tokensWhenUsed(count=${shown})`);
        } finally { numberFormat.mockRestore(); }
    });

    it.each(['link', 'upload'] as const)('does not read an unopened catalog from the %s tab, then loads Browse on demand', async modeKey => {
        const { externalRequests, sourceId } = await createRegistrySourcesUiHome(`demand-${modeKey}`);
        const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{ modeKey, sourceId }} />);
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { flushHookEffects } = await import('@/dev/testkit');
        const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
        await flushHookEffects();
        await waitForHomeGovernance(() => expect(screen.findByType(CapabilityAddModalBody).props.config.catalog.loading).toBe(false));
        // The configured source is a real GitHub HTTP boundary, reached only by catalog demand.
        expect(externalRequests.filter(url => url.includes('api.github.com/repos/fixture/skills'))).toHaveLength(0);
        const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
        await React.act(async () => { screen.findByType(SegmentedTabBar).props.onSelectTab('browse'); });
        await waitForHomeGovernance(() => expect(externalRequests.some(url => url.includes('/git/trees/'))).toBe(true));
        await waitForHomeGovernance(() => expect(screen.find(node => node.props.testID === 'skills.add:collection'
            && typeof node.props.model?.actions?.open === 'function').props.model.keys).toContain(`${sourceId}|review`));
    });

    for (const rulesUnavailable of [false, true]) it(`keeps missing batch content recoverable after an acknowledgment (rules unavailable: ${rulesUnavailable})`, async () => {
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const skills = ['review', 'lint'].map(name => createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: name, title: name,
            files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Check changes\n---\nCheck the changes.` }] }));
        const fixture = await createRegistrySourcesUiHome(`missing-batch-${rulesUnavailable}`, { external: async url => {
            if (url.includes('/git/trees/')) return Response.json({ sha: 'a'.repeat(40), tree: skills.flatMap(skill => {
                if (skill.item.payload.kind !== 'skill') throw new Error('Expected skill fixture');
                const payload = skill.item.payload.skill;
                return [{ path: payload.ref.path, type: 'tree', mode: '040000', sha: payload.ref.treeSha },
                    ...payload.files.map(file => ({ path: `${payload.ref.path}/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size }))];
            }) });
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) {
                const skill = skills.find(skill => url.endsWith(`/${skill.item.summary.itemId}/SKILL.md`));
                if (skill) return new Response(Buffer.from(skill.files[0]!.contentBase64, 'base64').toString('utf8'));
            }
            return null;
        } });
        const onAdded = vi.fn(), onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'link', onAdded }} />);
        const addBusy = () => screen.find(node => node.props?.testID === 'skills.add.link.add' && typeof node.props.loading === 'boolean').props.loading;
        await React.act(async () => { screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills'); });
        await screen.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.link.add')).not.toBeNull());
        fixture.setContentUnavailableAfter(1);
        fixture.setRulesUnavailable(rulesUnavailable);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(fixture.home.boundary.list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(addBusy()).toBe(false));
        const acknowledgedId = fixture.home.boundary.list()[0]!.id;
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('skills.add.link.add-error')).not.toBeNull();
        // A successful rules-only repair must leave the separate content failure visible.
        fixture.setRulesUnavailable(false);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(addBusy()).toBe(false));
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('skills.add.link.add-error')).not.toBeNull();
        expect(fixture.home.boundary.list().map(row => row.id)).toEqual([acknowledgedId]);
        const row = fixture.catalog.read('skill-rules');
        if (row.key !== 'skill-rules') throw new Error('Expected skill rules');
        expect(row.value.rules.map(rule => rule.skillId)).toContain(acknowledgedId);
        fixture.setContentUnavailableAfter(null);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(onAdded).toHaveBeenCalledExactlyOnceWith(acknowledgedId));
        expect(onClose).toHaveBeenCalledOnce();
        expect(fixture.home.boundary.list()).toHaveLength(2);
        expect(fixture.home.boundary.list().map(row => row.id)).toContain(acknowledgedId);
    });

    it('keeps a shelf partial acknowledgment recoverable even when the new content is already in the library', async () => {
        let phase = 'create Home';
        onTestFailed(() => console.error('Shelf recovery phase:', phase));
        const { home, sourceId, skill, catalog, setRulesUnavailable } = await createRegistrySourcesUiHome('shelf-partial');
        const { SkillsRegistryShelf } = await import('../SkillsRegistryShelf');
        const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
        function Shelf() {
            const library = useSkillsLibrary();
            return <SkillsRegistryShelf library={library} shelf={{ items: [skill.item.summary], sourceId, loading: false,
                error: null, status: null, sourceFailures: [], refresh: async () => {} }} brandNew={false} />;
        }
        phase = 'render';
        const screen = await renderScreen(<Shelf />);
        const { RegistryShelf } = await import('@/components/capabilities/add/RegistryShelf');
        const { CoreCollectionScope } = await import('@/components/ui/lists/collection/CoreCollectionScope');
        // The renderer's native Collection has no measured grid viewport. Render its real action slot explicitly.
        const actionElement = () => <CoreCollectionScope>{screen.findByType(RegistryShelf).props.action(skill.item.summary)}</CoreCollectionScope>;
        const action = await renderScreen(actionElement());
        setRulesUnavailable(true);
        phase = 'press Add';
        await action.pressByTestIdAsync('skills.home.shelf.review.add');
        phase = 'wait content';
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        await waitForHomeGovernance(async () => {
            await action.update(actionElement());
            expect(action.findByTestId('skills.home.shelf.review.partial')).not.toBeNull();
        });
        expect(action.findByTestId('skills.home.shelf.review.added')).toBeNull();
        const skillId = home.boundary.list()[0]!.id;
        setRulesUnavailable(false);
        await action.pressByTestIdAsync('skills.home.shelf.review.partial-action');
        await waitForHomeGovernance(() => expect(catalog.read('skill-rules').value).toMatchObject({ rules: [expect.objectContaining({ skillId, enabled: true })] }));
        await action.update(actionElement());
        expect(action.findByTestId('skills.home.shelf.review.added')).not.toBeNull();
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
        expect(catalog.read('skill-rules').value).toMatchObject({ rules: [expect.objectContaining({ skillId, enabled: true })] });
    });

    it('retains and repairs all sibling rule acknowledgments through the real install Action', async () => {
        let phase = 'create Home';
        onTestFailed(() => console.error('Sibling recovery phase:', phase));
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const sibling = createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: 'lint', title: 'lint', files: [
            { path: 'SKILL.md', content: '---\nname: lint\ndescription: Check style\n---\nCheck the style.' },
        ] });
        if (sibling.item.payload.kind !== 'skill') throw new Error('Expected skill');
        const siblingPayload = sibling.item.payload.skill;
        const primary = createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: 'review', title: 'review', files: [
            { path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\nUse [lint](../lint/SKILL.md).' },
            { path: 'check.sh', content: '#!/bin/sh\nexit 0', unixMode: 0o755 },
        ] });
        if (primary.item.payload.kind !== 'skill') throw new Error('Expected skill');
        const main = primary.item.payload.skill;
        const fixture = await createRegistrySourcesUiHome('modal-sibling-partial', { external: async url => {
            if (url.includes('/git/trees/')) {
                return Response.json({ sha: main.ref.treeSha, tree: [
                    { path: 'review', type: 'tree', mode: '040000', sha: main.ref.treeSha },
                    ...main.files.map(file => ({ path: `review/${file.path}`, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644', sha: file.blobSha, size: file.size })),
                    { path: 'lint', type: 'tree', mode: '040000', sha: siblingPayload.ref.treeSha },
                    ...siblingPayload.files.map(file => ({ path: `lint/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size })),
                ] });
            }
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/') && url.endsWith('/review/SKILL.md'))
                return new Response('---\nname: review\ndescription: Review changes\n---\nUse [lint](../lint/SKILL.md).');
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/') && url.endsWith('/lint/SKILL.md'))
                return new Response(Buffer.from(sibling.files[0]!.contentBase64, 'base64').toString('utf8'));
            return null;
        } });
        const onClose = vi.fn();
        const onAdded = vi.fn();
        phase = 'render';
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId: fixture.sourceId, onAdded }} />);
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        phase = 'wait catalog';
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${fixture.sourceId}|review`));
        phase = 'open detail';
        await React.act(async () => { collection().props.model.actions.open(`${fixture.sourceId}|review`); });
        phase = 'wait detail';
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(false));
        fixture.setRulesUnavailable(true);
        phase = 'install';
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull());
        expect(fixture.home.boundary.list()).toHaveLength(2);
        const ids = fixture.home.boundary.list().map(row => row.id).sort();
        // Re-pressing the main action is also recovery: it must never recreate either acknowledged skill.
        phase = 'repeat primary';
        await screen.pressByTestIdAsync('skills.add:primary');
        expect(fixture.home.boundary.list().map(row => row.id).sort()).toEqual(ids);
        fixture.setRulesUnavailable(false);
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).toBeNull());
        const row = fixture.catalog.read('skill-rules');
        expect(row.key).toBe('skill-rules');
        if (row.key !== 'skill-rules') throw new Error('Expected rules');
        await waitForHomeGovernance(() => {
            const current = fixture.catalog.read('skill-rules');
            if (current.key !== 'skill-rules') throw new Error('Expected rules');
            expect(current.value.rules.filter(rule => ids.includes(rule.skillId)).map(rule => rule.skillId).sort()).toEqual(ids);
        });
        expect(fixture.home.boundary.list().map(row => row.id).sort()).toEqual(ids);
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
    });

    it('installs the reviewed pin, keeps a partial add selected, and retries only its changed rules', async () => {
        let phase = 'admit Home';
        onTestFailed(() => console.error('Skill Add phase:', phase));
        const { home, sourceId, skill, catalog, setRulesUnavailable, moveBranch, externalRequests } =
            await createRegistrySourcesUiHome('modal-partial');
        const onAdded = vi.fn();
        const onClose = vi.fn();
        phase = 'render';
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId, onAdded }} />);
        phase = 'wait catalog';
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        // The native host boundary has no measured viewport. Open through the real Collection model, as its row does.
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${sourceId}|review`));
        phase = 'open detail';
        await React.act(async () => { collection().props.model.actions.open(`${sourceId}|review`); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(false));
        phase = 'set Where';
        await React.act(async () => {
            await screen.findByType(WhereItsOnControl).props.onChange({ kind: 'replace', rules: [
                { target: { t: 'allMachines' }, enabled: true },
                { target: { t: 'allMachines' }, agentId: 'gemini', enabled: false },
            ] });
        });
        moveBranch();
        setRulesUnavailable(true);
        phase = 'install';
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull());
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
        const created = home.boundary.list();
        expect(created).toHaveLength(1);
        const skillId = created[0]!.id;
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().artifacts[skillId]?.header).toMatchObject({ skillLock: { provenance: { kind: 'registry', registry: {
            sourceId, itemId: 'review', ref: { commit: skill.item.summary.version },
        } } } });
        expect(externalRequests.some(url => url.endsWith(`/commits/${'b'.repeat(40)}`))).toBe(false);
        setRulesUnavailable(false);
        phase = 'retry rules';
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).toBeNull());
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
        await waitForHomeGovernance(() => expect(catalog.read('skill-rules').value).toMatchObject({ rules: expect.arrayContaining([
            expect.objectContaining({ skillId, target: { t: 'allMachines' }, enabled: true }),
            expect.objectContaining({ skillId, target: { t: 'allMachines' }, agentId: 'gemini', enabled: false }),
        ]) }));
        expect(screen.findByTestId(`skills.add:detail:${sourceId}|review`)).not.toBeNull();
    });

    it('opens, rather than adds again, a registry skill the library holds from a link to the same folder', async () => {
        const { home, sourceId } = await createRegistrySourcesUiHome('modal-held-link');
        const onAdded = vi.fn();
        const link = await renderScreen(<SkillAddModal onClose={() => {}} params={{ modeKey: 'link', onAdded }} />);
        await React.act(async () => { link.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills/tree/main/review'); });
        await link.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(link.findByTestId('skills.add:primary')).not.toBeNull());
        await link.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(onAdded).toHaveBeenCalled());
        const skillId = home.boundary.list()[0]!.id;
        const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{ sourceId, onAdded: vi.fn() }} />);
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${sourceId}|review`));
        await React.act(async () => { collection().props.model.actions.open(`${sourceId}|review`); });
        // The list's own match is by registry identity and does not know the link; the preview after the read does.
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('capabilities.skillAdd.open'));
        expect(screen.getTextContent()).not.toContain('capabilities.skillAdd.addToLibrary');
        await screen.pressByTestIdAsync('skills.add:primary');
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
    });
    it('draws a registry that lists no skills as an empty state that leads on to writing one', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('modal-empty-registry', { external: async url =>
            url.includes('/git/trees/') ? Response.json({ sha: 'a'.repeat(40), tree: [] }) : null });
        const onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId, onAdded: vi.fn() }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.empty')).not.toBeNull());
        expect(screen.getTextContent()).toContain('capabilities.skillAdd.emptyTitle');
        await screen.pressByTestIdAsync('skills.add.empty.write');
        expect(screen.findByTestId('skill.draft.header')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });
});
