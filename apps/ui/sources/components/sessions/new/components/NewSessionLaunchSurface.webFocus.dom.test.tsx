/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { NewSessionTemporaryComputerLaunch } from './NewSessionLaunchSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: <T,>(values: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { NewSessionLaunchSurface } = await import('./NewSessionLaunchSurface');
const { createRunnerActivationClient } = await import('@/sync/api/ephemeralRunner/runnerActivationClient');
const { listWebFocusableElements } = await import('@/keyboard/webFocusableElements');

type MountedSurface = Readonly<{
    /** Starts (pending activation answered by the Home) or clears (Home has none for the draft) the launch. */
    render: (input: Readonly<{ frozen: boolean }>) => Promise<void>;
    onLeave: ReturnType<typeof vi.fn>;
    unmount: () => Promise<void>;
}>;

const mountedSurfaces: MountedSurface[] = [];

afterEach(async () => {
    while (mountedSurfaces.length > 0) {
        await mountedSurfaces.pop()?.unmount();
    }
});

describe('NewSessionLaunchSurface web focus containment', () => {
    it('moves focus into the launch overlay, contains Tab, and returns focus to Send when the attempt clears', async () => {
        const surface = await mountSurface({ frozen: false });
        const send = requireElement<HTMLButtonElement>('new-session-send');
        send.focus();
        expect(document.activeElement).toBe(send);

        await surface.render({ frozen: true });

        const overlay = requireElement('new-session-launch-overlay');
        const authoring = requireElement('new-session-launch-authoring');
        expect(document.activeElement).toBe(overlay);
        expect(overlay.getAttribute('role')).toBe('dialog');
        expect(overlay.getAttribute('aria-modal')).toBe('true');
        expect(authoring.hasAttribute('inert')).toBe(true);
        expect(authoring.getAttribute('aria-hidden')).toBe('true');

        // The launch card's own actions (Continue later, Cancel) are the only Tab stops.
        const actions = listWebFocusableElements(overlay).filter((element) => element !== overlay);
        expect(actions.length).toBeGreaterThanOrEqual(2);
        const first = actions[0]!;
        const last = actions[actions.length - 1]!;
        last.focus();
        dispatchTab();
        expect(document.activeElement).toBe(first);
        first.focus();
        dispatchTab({ shiftKey: true });
        expect(document.activeElement).toBe(last);

        await surface.render({ frozen: false });
        expect(document.activeElement).toBe(send);
    });

    it('routes Escape to the launch dismissal owner while the frozen composer stays mounted', async () => {
        const surface = await mountSurface({ frozen: false });
        requireElement<HTMLButtonElement>('new-session-send').focus();
        await surface.render({ frozen: true });

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
        });

        // A pending package is never revoked by a gesture: Escape leaves the composer with the draft kept.
        expect(surface.onLeave).toHaveBeenCalledTimes(1);
        expect(requireElement('new-session-prompt')).toBeTruthy();
    });

    it('leaves Escape to the focused field while no launch is pending', async () => {
        // A retained composer with no pending launch sits behind every page (QB-80: the Sessions search kept its
        // query and stayed open on Escape while one was mounted).
        const surface = await mountSurface({ frozen: false });
        const field = document.createElement('input');
        document.body.appendChild(field);
        field.focus();
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

        await act(async () => { field.dispatchEvent(escape); });

        expect(escape.defaultPrevented).toBe(false);
        expect(surface.onLeave).not.toHaveBeenCalled();
        field.remove();
    });
});

const pendingProjection: RunnerActivationProjectionV1 = {
    activationId: '00000000-0000-4000-8000-000000000001',
    homeServerIdentityId: 'srv_runner', creatorAccountId: 'creator', creatorTokenEpoch: 1,
    activationExpiresAt: null, workspace: { kind: 'choose_on_endpoint' },
    sessionId: 'session-1', machineId: 'machine-1', activationSigningPublicKey: 'a'.repeat(43),
    authoringCommitment: 'a'.repeat(43),
    artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
    endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator' },
    draftId: 'draft-a', state: 'pending', closeReason: null, progressPhase: null,
    claim: null, endpointFacts: null, review: null, consent: null, readiness: null, materialization: null,
};

async function mountSurface(initial: Readonly<{ frozen: boolean }>): Promise<MountedSurface> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onLeave = vi.fn();
    let homeHasActivation = initial.frozen;
    const controlRef: NewSessionTemporaryComputerLaunch['controlRef'] = { current: null };
    const launch: NewSessionTemporaryComputerLaunch = {
        input: {
            // The Home's HTTP read is the transport boundary; the launch controller stays real.
            client: createRunnerActivationClient(async () => homeHasActivation
                ? Response.json(pendingProjection)
                : Response.json({ error: 'not_found' }, { status: 404 })),
            serverId: 'home-a', draftId: 'draft-a', existingPublicRef: null,
            prepareActivation: async () => { throw new Error('Unexpected activation creation'); },
            persistPublicRef: () => undefined,
            onMaterialized: () => undefined,
        },
        controlRef,
        scope: null,
        committedTarget: null,
        homeLabel: 'Home A',
        accountLabel: null,
        exportPackage: async () => undefined,
        onActiveChange: () => undefined,
        onLeave,
    };
    const surface: MountedSurface = {
        onLeave,
        render: async (input) => {
            homeHasActivation = input.frozen;
            await act(async () => { await controlRef.current?.refresh(); });
            await vi.waitFor(() => {
                expect(document.querySelector('[data-testid="temporary-computer-launch-surface"]') !== null)
                    .toBe(input.frozen);
            });
            await act(async () => {});
        },
        unmount: async () => {
            await act(async () => { root.unmount(); });
            container.remove();
        },
    };
    mountedSurfaces.push(surface);
    await act(async () => {
        root.render(
            <NewSessionLaunchSurface temporaryComputerLaunch={launch}>
                <input data-testid="new-session-prompt" />
                <button data-testid="new-session-send">Send</button>
            </NewSessionLaunchSurface>,
        );
    });
    await surface.render(initial);
    return surface;
}

function requireElement<TElement extends HTMLElement = HTMLElement>(testId: string): TElement {
    const element = document.querySelector<TElement>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`Missing ${testId}`);
    return element;
}

function dispatchTab(options?: Readonly<{ shiftKey?: boolean }>): void {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: options?.shiftKey === true,
        bubbles: true,
        cancelable: true,
    }));
}
