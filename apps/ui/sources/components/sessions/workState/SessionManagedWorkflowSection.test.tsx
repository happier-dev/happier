import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

afterEach(async () => {
    await standardCleanup();
});

type SectionProps = React.ComponentProps<typeof import('./SessionManagedWorkflowSection').SessionManagedWorkflowSection>;

async function renderSection(overrides: Omit<Partial<SectionProps>, 'state'> & { state?: Partial<SectionProps['state']> } = {}) {
    const { SessionManagedWorkflowSection } = await import('./SessionManagedWorkflowSection');
    return renderScreen(React.createElement(SessionManagedWorkflowSection, {
        onOpenRun: () => {},
        ...overrides,
        state: {
            phase: 'loaded',
            runs: [],
            attentionRunIds: new Set<string>(),
            refreshFailed: false,
            retry: () => {},
            ...overrides.state,
        },
    }));
}

describe('session managed workflow section', () => {
    it('stays absent for a Session that has started no managed workflow', async () => {
        const screen = await renderSection();
        expect(screen.findByTestId('session-managed-workflows')).toBeNull();
    });

    it('opens the exact run rather than a latest-run lookup', async () => {
        const opened: string[] = [];
        const screen = await renderSection({
            state: {
                phase: 'loaded',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-1', origin: { kind: 'direct', originSessionId: 'session-1' } }),
                    createWorkflowRunSummaryFixture({ id: 'run-2', origin: { kind: 'direct', originSessionId: 'session-1' } }),
                ],
                attentionRunIds: new Set<string>(),
            },
            onOpenRun: (runId: string) => opened.push(runId),
        });

        await screen.pressByTestIdAsync('session-managed-workflows-run-run-2');
        expect(opened).toEqual(['run-2']);
    });

    it('shows the canonical Run state with a marker and offers Open by default', async () => {
        const screen = await renderSection({
            state: {
                phase: 'loaded',
                runs: [createWorkflowRunSummaryFixture({
                    id: 'run-1',
                    state: 'running',
                    origin: { kind: 'direct', originSessionId: 'session-1' },
                })],
                metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Frozen session title' } } },
                attentionRunIds: new Set<string>(),
            },
        });

        expect(screen.findHostByTestId('session-managed-workflows-run-run-1-state')?.props.accessibilityLabel).toBe('workflows.runState.running');
        expect(screen.findByTestId('session-managed-workflows-run-run-1-state-marker')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-1-open')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-1-review')).toBeNull();
        expect(screen.getTextContent()).toContain('Frozen session title');
        expect(screen.findByTestId('session-managed-workflows-run-run-1')?.props.accessibilityLabel)
            .toContain('Frozen session title');
    });

    /**
     * A Run nothing Account-private names yet keeps its identity; only the real
     * encrypted state may claim private content is unavailable on this device.
     */
    it('names an unread Run as a workflow run and reserves the unavailable claim for the encrypted state', async () => {
        const screen = await renderSection({
            state: {
                phase: 'loaded',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-unread', origin: { kind: 'direct', originSessionId: 'session-1' } }),
                    createWorkflowRunSummaryFixture({ id: 'run-locked', origin: { kind: 'direct', originSessionId: 'session-1' } }),
                ],
                metadataByRunId: { 'run-locked': { kind: 'unavailable', reason: 'content_unavailable' } },
                attentionRunIds: new Set<string>(),
            },
        });

        expect(screen.findByTestId('session-managed-workflows-run-run-unread')?.props.accessibilityLabel)
            .toContain('workflows.run.untitled');
        expect(screen.findByTestId('session-managed-workflows-run-run-unread')?.props.accessibilityLabel)
            .not.toContain('workflows.contentUnavailable');
        expect(screen.findByTestId('session-managed-workflows-run-run-locked')?.props.accessibilityLabel)
            .toContain('workflows.contentUnavailable');
    });

    it('offers Review exactly for the Runs the server attention predicate returned', async () => {
        const screen = await renderSection({
            state: {
                phase: 'loaded',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-quiet', state: 'running', origin: { kind: 'direct' } }),
                    createWorkflowRunSummaryFixture({ id: 'run-waiting', state: 'running', origin: { kind: 'direct' } }),
                ],
                // Attention is not derived from the Run state: an approval can be
                // waiting inside an invocation this client has never loaded.
                attentionRunIds: new Set(['run-waiting']),
            },
        });

        expect(screen.findByTestId('session-managed-workflows-run-run-waiting-review')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-quiet-open')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-quiet-review')).toBeNull();
    });

    it('says a failed read failed instead of claiming the Session started nothing', async () => {
        const screen = await renderSection({
            state: { phase: 'failed', refreshFailed: true, runs: [], attentionRunIds: new Set<string>() },
        });
        expect(screen.findByTestId('session-managed-workflows-error')).not.toBeNull();
    });

    /**
     * A refresh that failed still knows what it read last. Replacing hydrated
     * rows with a bare error erased the entry point to a Run that was waiting
     * on the person, so the rows stay and the failure is stated beside them.
     */
    it('keeps hydrated rows visible while reporting that the refresh failed', async () => {
        const screen = await renderSection({
            state: {
                phase: 'loaded',
                refreshFailed: true,
                runs: [createWorkflowRunSummaryFixture({
                    id: 'run-1', state: 'running', origin: { kind: 'direct', originSessionId: 'session-1' },
                })],
                attentionRunIds: new Set(['run-1']),
            },
        });

        expect(screen.findByTestId('session-managed-workflows-error')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-1')).not.toBeNull();
        expect(screen.findByTestId('session-managed-workflows-run-run-1-review')).not.toBeNull();
    });
});
