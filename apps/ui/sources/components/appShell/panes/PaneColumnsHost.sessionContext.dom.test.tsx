/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// Real RNW hosts expose focus/inert semantics; only viewport and native animation adapters are replaced.
vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () => ({
    ...(await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock(),
    ScrollView: (await vi.importActual<typeof import('react-native-web')>('react-native-web')).ScrollView,
}));

// Initialize real sync subscription owners before the shell's transitive account readers.
// Keep account logic real rather than masking its import-order dependency with mocks.
await import('@/sync/syncEngine');
const { PaneColumnsHost } = await import('./PaneColumnsHost');
const { resolveRightSidebarTabs, resolveRightSidebarTabPlacement } = await import('../rightSidebar/rightSidebarTabRegistry');
const { SessionViewLayout } = await import('@/components/sessions/shell/view/SessionViewLayout');
const { ChatHeaderView } = await import('@/components/sessions/transcript/ChatHeaderView');
const { PaneMainComposerAnchor } = await import('@/components/ui/panels/paneMainComposerAnchor');
const { useLayoutPresentationActive, usePluginSurfaceFocusEligibility } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

it('withdraws the covered session body while retaining its composer and the catalog-placed context', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    const facts: Record<string, { presented: boolean; focusable: boolean }> = {};
    let mounts = 0;
    function Control({ name }: Readonly<{ name: string }>) {
        facts[name] = { presented: useLayoutPresentationActive(), focusable: usePluginSurfaceFocusEligibility() };
        React.useEffect(() => { if (name === 'transcript') mounts += 1; }, [name]);
        return <input data-testid={name} defaultValue={name} />;
    }
    const main = <>
        <ChatHeaderView title="Session" showBackButton={false} rightElement={<Control name="header" />} />
        <SessionViewLayout content={<Control name="transcript" />} placeholder={null}
            input={<PaneMainComposerAnchor><Control name="composer" /></PaneMainComposerAnchor>}
            shouldShowCliWarning onDismissCliWarning={() => {}} isLandscape deviceType="tablet" onBackPress={() => {}} />
    </>;
    const render = async (contextOpen: boolean, arrangement: 'editor' | 'session' = 'editor') => {
        const context = { scope: 'session', arrangement } as const;
        const agents = resolveRightSidebarTabs(context).find(tab => tab.id === 'agents');
        expect(agents).toBeDefined();
        await act(async () => root.render(
            <PaneColumnsHost main={main} arrangement={arrangement} emptyEditorPane={<input data-testid="editor" />}
                rightPane={contextOpen ? <Control name="people" /> : null} rightOpen={contextOpen}
                rightPlacement={resolveRightSidebarTabPlacement(agents!, context)} />,
        ));
    };
    await render(false);
    const transcript = container.querySelector<HTMLInputElement>('[data-testid="transcript"]')!;
    expect(transcript).not.toBeNull();
    transcript.value = 'Retained draft';
    transcript.focus();
    transcript.setSelectionRange(2, 5);

    await render(true);
    const header = container.querySelector('[data-testid="header"]')!;
    const composer = container.querySelector<HTMLInputElement>('[data-testid="composer"]')!;
    expect(container.querySelector('[data-testid="multi-pane-right-main"]')).not.toBeNull();
    expect(transcript.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    expect(header.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    const warning = container.querySelector('[data-testid="session-view-cli-warning"]');
    expect(warning).not.toBeNull();
    expect(warning!.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    expect(composer.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(facts.transcript).toEqual({ presented: false, focusable: false });
    expect(facts.header).toEqual({ presented: false, focusable: false });
    expect(facts.composer).toEqual({ presented: true, focusable: true });
    expect(facts.people).toEqual({ presented: true, focusable: true });
    composer.focus();
    expect(document.activeElement).toBe(composer);

    await render(true, 'session');
    expect(transcript.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(facts.transcript).toEqual({ presented: true, focusable: true });
    await render(false);
    expect(container.querySelector('[data-testid="transcript"]')).toBe(transcript);
    expect(transcript.value).toBe('Retained draft');
    expect([transcript.selectionStart, transcript.selectionEnd]).toEqual([2, 5]);
    expect(mounts).toBe(1);
});
