import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
const native = vi.hoisted(() => ({ listeners: new Set<(event: import('@/keyboard/runtime').NativeHardwareKeyboardEventLike) => void>() }));
// Only native hardware delivery is replaced; shortcut dispatch and Action admission stay real.
vi.mock('expo-modules-core', async importOriginal => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierHardwareKeyboardShortcuts' ? {
        addListener: (_event: string, listener: (event: import('@/keyboard/runtime').NativeHardwareKeyboardEventLike) => void) => {
            native.listeners.add(listener);
            return { remove: () => native.listeners.delete(listener) };
        },
        setHardwareKeyEventsEnabled() {}, setHardwareKeyConsumableEventSignatures() {},
    } : null,
}));

const { PromptPickerView } = await import('../AgentInputPromptPicker');
const { usePromptPickerLibrary } = await import('../usePromptPickerLibrary');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { standardCleanup(); await flushHookEffects(); await fixture?.dispose(); vi.restoreAllMocks(); });

function Picker({ serverId }: Readonly<{ serverId: string }>) {
    const library = usePromptPickerLibrary(serverId);
    const history = { entries: [], coverage: 'complete' as const, hasMore: false, isLoading: false, error: false,
        progress: { pagesLoaded: 0, sessionsSearched: 0, totalSessions: 0 } };
    return <KeyboardShortcutProvider handlers={{}}><PromptPickerView
        anchor={{ kind: 'view', ref: { current: null } }} serverId={serverId} sessionId="s1" canSend
        onRequestClose={() => {}} onApply={async () => false} library={library}
        history={{ ...history, loadMore: async () => history, retry: async () => history, stop: () => history }}
        folderNames={new Map()} sessionNames={new Map()} nowMs={0} hardwareKeyboard />
    </KeyboardShortcutProvider>;
}

describe('picker favourite Action admission', () => {
    it.each([
        { entry: 'star', disabled: true }, { entry: 'keyboard', disabled: true },
        { entry: 'star', disabled: false }, { entry: 'keyboard', disabled: false },
    ])('admits only an enabled Action from the real picker $entry (disabled=$disabled)', async ({ entry, disabled }) => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            actions: disabled ? { 'prompt_doc.favorite.set': { disabledSurfaces: ['ui'] } } : {} });
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://picker-favorite.test', { handleRequest: async (path, init) =>
            path === '/v2/account/settings' ? new Response(JSON.stringify({ version: 3, content: { t: 'plain', v: { actionsSettingsV1 } } }),
                { headers: { 'content-type': 'application/json' } }) : catalog.handle(path, init),
        });
        await fixture.hydrateAccountSettings();
        const serverId = fixture.home.id;
        const account = await captureLazyActionAccountContext(serverId);
        const { artifactId } = await createPromptDocInLibrary({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
            request: { title: 'Testing', markdown: 'Test $ARGUMENTS', favorite: false } });
        account.dispose();
        const screen = await renderScreen(<Picker serverId={serverId} />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId(`prompt-picker-favorite:doc:${artifactId}`)).not.toBeNull();
        });
        const before = fixture.boundary.read(artifactId);
        if (entry === 'star') await screen.pressByTestIdAsync(`prompt-picker-favorite:doc:${artifactId}`);
        else {
            await act(async () => screen.findByTestId('prompt-picker-search')!.props.onFocus());
            await act(async () => { for (const listener of native.listeners) listener({ key: 'd', code: 'KeyD', repeat: false,
                modifiers: { shift: false, ctrl: false, meta: true, alt: false } }); });
        }
        await flushHookEffects({ cycles: 30, turns: 10 });
        if (disabled) {
            expect(fixture.boundary.read(artifactId)).toEqual(before);
            expect(screen.getTextContent()).toContain('agentInput.promptPicker.applyError');
        } else {
            expect(decodePlainArtifactStoredContent(fixture.boundary.read(artifactId)!.header)).toMatchObject({ favorite: true });
            expect(screen.getTextContent()).not.toContain('agentInput.promptPicker.applyError');
        }
        expect(screen.findByTestId(`prompt-picker-favorite:doc:${artifactId}`)?.props['aria-pressed']).toBe(!disabled);
    });
});
