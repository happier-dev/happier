import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotTemplateUpdateApplyInputV1Schema, BotTemplateUpdateDiffResultV1Schema,
    type BotTemplateUpdateApplyInputV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { BotTemplateUpdateForm } from './BotTemplateUpdateReview';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function reviewFixture() {
    return BotTemplateUpdateDiffResultV1Schema.parse({ sessionRef: { serverId: 'home', sessionId: 'garden' }, metadataRevision: 7,
        instance: { v: 1, source: { kind: 'artifact', serverId: 'home', artifactId: 'source' }, acceptedVersion: '1.0.0',
            acceptedBase: { serverId: 'home', artifactId: 'base' }, skillIds: {}, mcpServerIds: {}, follow: true }, offer: 'available',
        upstream: { source: { kind: 'artifact', serverId: 'home', artifactId: 'source' }, revision: { headerVersion: 1, bodyVersion: 2 },
            presentation: { ownerDisplayName: 'Ana', shared: true },
            release: { v: 1, version: '1.1.0', releasedAtMs: 1, changelog: 'Care for herbs',
                content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Author\nNew section\n' },
                    skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } } },
        acceptedSuggestions: {},
        instructions: { title: 'Garden instructions', ref: { serverId: 'home', artifactId: 'instructions' }, revision: { headerVersion: 2, bodyVersion: 4 },
            comparison: { segments: [{ index: 0, kind: 'conflict', base: 'Base\n', mine: 'Mine\n', theirs: 'Author\n' },
                { index: 1, kind: 'theirs', base: '', mine: '', theirs: 'New section\n' }], text: 'Mine\nNew section\n' } },
        skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } });
}

describe('template update review', () => {
    it('retains the preview owner’s author and sharing facts in the update header', async () => {
        const screen = await renderScreen(<BotTemplateUpdateForm review={reviewFixture()} ready update={{ mutation: { kind: 'idle' },
            errorCode: null, reload: async () => {}, skip: async () => {}, stop: async () => {}, apply: async () => {} }} />);
        const byline = screen.findByTestId('bot-template-byline');
        expect(byline).toBeTruthy();
        expect(screen.getTextContent()).toContain('Ana');
        expect(screen.getTextContent()).toContain('botTemplates.shared');
    });
    // REAL-USER-PASS F8: the page named the template over the person's own Bot and dumped the whole document.
    it("leads with the recipient's own Bot and the changed lines, and says what Update will do", async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        storage.getState().applySessions([createSessionFixture({ id: 'garden', serverId: 'home',
            metadata: { path: '/garden', host: 'home', name: 'My herb keeper', bot: { kind: 'bot' } } as never })]);
        const screen = await renderScreen(<BotTemplateUpdateForm review={reviewFixture()} ready update={{ mutation: { kind: 'idle' },
            errorCode: null, reload: async () => {}, skip: async () => {}, stop: async () => {}, apply: async () => {} }} />);
        const text = screen.getTextContent();
        expect(text).toContain('My herb keeper');
        expect(text).toContain('botTemplates.updateConsequence(name=My herb keeper,version=1.1.0)');
        expect(screen.findByTestId('bot-template-update:taken')).not.toBeNull();
        // REAL-USER-PASS-2 G8 (lab r2 update-whatsnew): the line both edited reads by person, only changed words marked.
        const changedWords = (testID: string) => screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)
            .map(node => node.props.children).join('');
        expect(changedWords('bot-template-update:instructions:0:theirs.changed')).toBe('Author');
        expect(changedWords('bot-template-update:instructions:0:mine.changed')).toBe('Mine');
        expect(text).toContain('Ana');
        expect(text).toContain('botTemplateRecipient.you');
        // The author's changes to lines the recipient never edited stay folded until opened, then show only those lines.
        expect(text).not.toContain('New section');
        await screen.pressByTestIdAsync('bot-template-update:taken');
        expect(changedWords('bot-template-update:taken:1:theirs.changed')).toBe('New section');
        // The resulting document stays behind its own disclosure.
        expect(screen.findByTestId('bot-template-update:preview-read')).toBeNull();
        await screen.unmount();
    });
    it('shows changed first-task and Agent suggestions as review-only values through Update', async () => {
        const review = BotTemplateUpdateDiffResultV1Schema.parse({ ...reviewFixture(),
            acceptedSuggestions: { firstTask: 'Sort the harvest', suggestedAgent: { agentId: 'claude', modelId: 'old-model' } },
            upstream: { ...reviewFixture().upstream, release: { ...reviewFixture().upstream.release,
                content: { ...reviewFixture().upstream.release.content, firstTask: 'Plan the planting',
                    suggestedAgent: { agentId: 'codex', modelId: 'new-model' } } } } });
        let submitted: BotTemplateUpdateApplyInputV1 | undefined;
        const screen = await renderScreen(<BotTemplateUpdateForm review={review} ready update={{ mutation: { kind: 'idle' },
            errorCode: null, reload: async () => {}, skip: async () => {}, stop: async () => {},
            apply: async input => { submitted = BotTemplateUpdateApplyInputV1Schema.parse(input); } }} />);
        expect(screen.getTextContent()).toContain('Sort the harvest');
        expect(screen.getTextContent()).toContain('Plan the planting');
        expect(screen.getTextContent()).toContain('Claude · old-model');
        expect(screen.getTextContent()).toContain('Codex · new-model');
        await screen.pressByTestIdAsync('bot-template-update:apply');
        expect(submitted).toBeDefined();
        expect(submitted).not.toHaveProperty('firstTask');
        expect(submitted).not.toHaveProperty('suggestedAgent');
        await screen.unmount();
    });
    it('keeps unchanged suggestions quiet and shows removed suggestions explicitly', async () => {
        const update = { mutation: { kind: 'idle' as const }, errorCode: null, reload: async () => {},
            skip: async () => {}, stop: async () => {}, apply: async () => {} };
        const unchangedReview = BotTemplateUpdateDiffResultV1Schema.parse({ ...reviewFixture(),
            acceptedSuggestions: { firstTask: 'Sort the harvest', suggestedAgent: { agentId: 'claude' } },
            upstream: { ...reviewFixture().upstream, release: { ...reviewFixture().upstream.release,
                content: { ...reviewFixture().upstream.release.content, firstTask: 'Sort the harvest',
                    suggestedAgent: { agentId: 'claude' } } } } });
        const unchanged = await renderScreen(<BotTemplateUpdateForm review={unchangedReview} ready update={update} />);
        expect(unchanged.getTextContent()).not.toContain('botTemplates.firstTask');
        expect(unchanged.getTextContent()).not.toContain('botTemplates.suggestedAgent');
        await unchanged.unmount();
        const removedReview = BotTemplateUpdateDiffResultV1Schema.parse({ ...reviewFixture(),
            acceptedSuggestions: { firstTask: 'Sort the harvest', suggestedAgent: { agentId: 'claude' } } });
        const removed = await renderScreen(<BotTemplateUpdateForm review={removedReview} ready update={update} />);
        expect(removed.getTextContent()).toContain('Sort the harvest');
        expect(removed.getTextContent()).toContain('Claude');
        expect(removed.getTextContent()).toContain('common.none');
        await removed.unmount();
    });
    it.each([false, true])('uses the owner’s Add availability for a deleted skill (canTake=%s)', async canTake => {
        const review = BotTemplateUpdateDiffResultV1Schema.parse({ ...reviewFixture(), skills: [{ key: 'herbs', title: 'Herbs',
            status: 'deleted', canTake, files: [] }] });
        let submitted: BotTemplateUpdateApplyInputV1 | undefined;
        const screen = await renderScreen(<BotTemplateUpdateForm review={review} ready update={{ mutation: { kind: 'idle' },
            errorCode: null, reload: async () => {}, skip: async () => {}, stop: async () => {},
            apply: async input => { submitted = input; } }} />);
        expect(screen.findByTestId('bot-template-update:skill:herbs:take')?.props.disabled).toBe(!canTake);
        await screen.pressByTestIdAsync('bot-template-update:apply');
        expect(submitted?.skills?.herbs.choice).toBe('skip');
        if (canTake) {
            await screen.pressByTestIdAsync('bot-template-update:skill:herbs:take');
            await screen.pressByTestIdAsync('bot-template-update:apply');
            expect(submitted?.skills?.herbs.choice).toBe('take');
        }
        await screen.unmount();
    });
    it('shares the visible edited preview and reviewed submission with mounted Agent read and patch commands', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'review', serverUrl: 'https://template-review.test', accountId: 'reviewer' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        let unregister: (() => void) | undefined;
        let reader: CurrentUiContextReader | null = null;
        const server = home.homes.review!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected the mounted review Account lifetime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        function Publication() {
            reader = useOptionalCurrentUiContextReader();
            const commands = useCurrentUiContextComposedCommands();
            usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
            React.useEffect(() => {
                if (!reader) return;
                const current = reader;
                unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({ reader: current,
                    invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null }));
                return unregister;
            }, [reader]);
            return null;
        }
        let submitted: BotTemplateUpdateApplyInputV1 | undefined;
        const update = { mutation: { kind: 'idle' as const }, errorCode: null, reload: async () => {},
            apply: async (input: BotTemplateUpdateApplyInputV1) => { submitted = BotTemplateUpdateApplyInputV1Schema.parse(input); },
            skip: async () => {}, stop: async () => {} };
        const review = BotTemplateUpdateDiffResultV1Schema.parse({ ...reviewFixture(), skills: [{ key: 'herbs', title: 'Herbs',
            status: 'existing', canTake: true, skillId: 'herbs-copy', revision: 'reviewed-skill-revision', files: [] }] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication /><BotTemplateUpdateForm review={review} update={update} ready isCurrent={authority.isCurrent} />
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        try {
            const inventory = reader!.readCurrentUiContext()!.commands;
            const read = inventory.find(command => command.title === 'common.details')!;
            const patch = inventory.find(command => command.title === 'common.edit')!;
            expect(read).toBeDefined();
            expect(patch).toBeDefined();
            const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
            await screen.pressByTestIdAsync('bot-template-update:preview-disclosure');
            await screen.pressByTestIdAsync('bot-template-update:preview-edit');
            await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: patch.id,
                input: { instructions: { '0': 'both' }, editedInstructions: 'Agent reviewed prose\n' } }, { surface: 'agent' })).toMatchObject({ ok: true }); });
            expect(screen.findByTestId('bot-template-update:preview')?.props.value).toBe('Agent reviewed prose\n');
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: read.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true, result: { instructions: { '0': 'both' }, editedInstructions: 'Agent reviewed prose\n',
                    skills: { herbs: { choice: 'take', expectedRevision: 'reviewed-skill-revision' } } } });
            await act(async () => { screen.changeTextByTestId('bot-template-update:preview', 'UI reviewed prose\n'); });
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: read.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true, result: { editedInstructions: 'UI reviewed prose\n' } });
            await screen.pressByTestIdAsync('bot-template-update:apply');
            expect(submitted).toMatchObject({
                instructions: { choices: { '0': 'both' }, markdown: 'UI reviewed prose\n', expectedRevision: { headerVersion: 2, bodyVersion: 4 } } });
        } finally {
            await screen.unmount(); unregister?.(); retireActiveServerAccountScopeLifetime(); await home.dispose();
        }
    });
    it('waits for new required setup and submits the recipient selections with the reviewed update', async () => {
        const review = reviewFixture();
        const value = { software: [], accounts: [{ key: 'calendar', selection: { action: 'skip' as const } }], mcpServers: [] };
        let submitted: BotTemplateUpdateApplyInputV1 | undefined;
        const update = { mutation: { kind: 'idle' as const }, errorCode: null, reload: async () => {},
            apply: async (input: BotTemplateUpdateApplyInputV1) => { submitted = BotTemplateUpdateApplyInputV1Schema.parse(input); },
            skip: async () => {}, stop: async () => {} };
        const screen = await renderScreen(<BotTemplateUpdateForm review={review} update={update} ready setup={{ value, ready: false, content: null }} />);
        expect(screen.findByTestId('bot-template-update:apply')?.props.disabled).toBe(true);
        await screen.update(<BotTemplateUpdateForm review={review} update={update} ready setup={{ value, ready: true, content: null }} />);
        await screen.pressByTestIdAsync('bot-template-update:apply');
        expect(submitted?.setup).toEqual(value);
        await screen.unmount();
    });

    it('keeps local overlap by default, previews Both with disjoint changes and submits the edited text with reviewed revisions', async () => {
        const review = reviewFixture();
        let submitted: BotTemplateUpdateApplyInputV1 | undefined;
        const update = { mutation: { kind: 'idle' as const }, errorCode: null, reload: async () => {},
            apply: async (input: BotTemplateUpdateApplyInputV1) => { submitted = BotTemplateUpdateApplyInputV1Schema.parse(input); },
            skip: async () => {}, stop: async () => {} };
        const screen = await renderScreen(<BotTemplateUpdateForm review={review} update={update} ready />);
        // The whole resulting document waits behind its own disclosure; the page leads with the changed lines.
        expect(screen.findByTestId('bot-template-update:preview')).toBeNull();
        await screen.pressByTestIdAsync('bot-template-update:preview-disclosure');
        // REAL-USER-PASS-2 G8: the result reads as Markdown, not raw text in a field, until the person chooses Edit.
        expect(screen.findByTestId('bot-template-update:preview')).toBeNull();
        expect(screen.root.findAll(node => node.props.testID === 'bot-template-update:preview-read'
            && typeof node.props.markdown === 'string')[0]?.props.markdown).toBe('Mine\nNew section\n');
        await screen.pressByTestIdAsync('bot-template-update:preview-edit');
        expect(screen.findByTestId('bot-template-update:preview')?.props.value).toBe('Mine\nNew section\n');
        await screen.pressByTestIdAsync('bot-template-update:instructions:0:both');
        expect(screen.findByTestId('bot-template-update:preview')?.props.value).toBe('Mine\nAuthor\nNew section\n');
        await act(async () => { screen.changeTextByTestId('bot-template-update:preview', 'Reviewed prose\nNew section\n'); });
        await screen.pressByTestIdAsync('bot-template-update:apply');
        expect(submitted).toMatchObject({ sessionRef: review.sessionRef, expectedVersion: '1.1.0',
            expectedRevision: { headerVersion: 1, bodyVersion: 2 }, instructions: { expectedRevision: { headerVersion: 2, bodyVersion: 4 },
                choices: { '0': 'both' }, markdown: 'Reviewed prose\nNew section\n' }, takeIdentity: false });
        await screen.pressByTestIdAsync('bot-template-update:instructions:0:mine');
        await screen.pressByTestIdAsync('bot-template-update:instructions:0:both');
        await screen.pressByTestIdAsync('bot-template-update:apply');
        expect(submitted?.instructions?.markdown).toBeUndefined();
        await screen.unmount();
    });

    it('offers Skip and Stop explicitly and displays an accepted version only after successful settlement', async () => {
        const review = reviewFixture();
        const skipped: string[] = [];
        let stops = 0;
        const controls = { errorCode: null, reload: async () => {}, apply: async () => {},
            skip: async (version: string) => { skipped.push(version); }, stop: async () => { stops += 1; } };
        const screen = await renderScreen(<BotTemplateUpdateForm review={review} ready update={{ ...controls, mutation: { kind: 'idle' } }} />);
        await screen.pressByTestIdAsync('bot-template-update:skip');
        // Stop following lives in the header's ⋯, never as an untitled card at the bottom (REAL-USER-PASS F8).
        expect(screen.findByTestId('bot-template-update:stop')).toBeNull();
        expect(screen.findByTestId('bot-template-update:more')).not.toBeNull();
        expect(skipped).toEqual(['1.1.0']);
        expect(stops).toBe(0);
        await screen.update(<BotTemplateUpdateForm review={review} ready update={{ ...controls, mutation: {
            kind: 'failed', result: { ok: false, errorCode: 'revision_conflict', error: 'revision_conflict',
                details: { applied: ['skill:herbs'], remaining: ['instructions'], resourceIds: ['skill-herbs'] } } } }} />);
        expect(screen.findByTestId('bot-template-update:apply')).not.toBeNull();
        expect(screen.getTextContent()).toContain('botTemplateRecipient.updateFailed');
        expect(screen.getTextContent()).toContain('botTemplateRecipient.remainingChanges');
        expect(screen.getTextContent()).toContain('botTemplateRecipient.appliedChanges');
        expect(screen.getTextContent()).not.toContain('botTemplateRecipient.updated');
        await screen.update(<BotTemplateUpdateForm review={review} ready update={{ ...controls,
            mutation: { kind: 'updated', result: { acceptedVersion: '1.1.0', applied: ['instructions'], kept: ['skill:herbs'], resourceIds: [] } } }} />);
        expect(screen.getTextContent()).toContain('botTemplateRecipient.updated');
        expect(screen.findByTestId('bot-template-update:apply')).toBeNull();
        await screen.unmount();
    });
});
